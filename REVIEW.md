# SyncStream review - architecture, correctness, security, reliability

Status: **final** (independently verified; see §7).

Reviewed: commit `e95fbf0` on `main`, 2026-10-12. Working tree carried two
uncommitted changes unrelated to the app (`package.json`/`bun.lock` add
`@google/adk`, used only by the untracked `tools/syncstream-agents/` package;
no `src/` or `tests/` reference it). Nothing under the repository was modified
by this review except this file. Reproductions live outside the tree in
`$CLAUDE_JOB_DIR/tmp` and are listed in §6.

Method: one coordinator (this document), three specialist passes each run
twice with different model families (Claude in-process; Orca-dispatched
Claude Sonnet for media, Codex GPT-6.1-Sol for connectivity/security and
sync/mesh), reconciled by evidence rather than vote, then challenged by an
independent Codex GPT-6-Astra verifier that re-ran the reproductions and one
Chromium run of its own. Evidence levels used below, exactly:

- **Confirmed (Chromium)** - observed in a real Chromium run on this machine.
- **Confirmed (module)** - reproduced by running the repository's own
  modules under Bun with fake media elements / peers.
- **Confirmed (static)** - unambiguous in code, read by at least two
  reviewers, no runtime run.
- **Likely** - unambiguous code path with a runtime consequence not
  exercised. **Hypothesis** - reasoning only.

A green reproduction script is an observation, not a passing acceptance test.

---

## 1. Architecture and trust-boundary map

```
 Host (desktop browser)                         Guests (any browser)
 ───────────────────────                        ────────────────────
 File (disk) ─File.slice()─▶ probe.ts ──tier──▶ reject | direct | transcode
      │                       (moov only, parsed twice)
      ▼
 source.ts  rep 0 CMAF segments at sync samples (LRU 200 MB)
 ladder.ts  rungs 720/480/360 via encode.worker.ts (WebCodecs, 1-2 workers, LRU 50 MB)
 manifest.ts DASH MPD over syncstream://rep/{r}/{track}/seg/{i}
 origin.ts  = source + ladder + manifest
      │ getInit/getSegment
      ▼
 room/host.ts ◀──control id 100 (JSON)──▶ room/guest.ts ──▶ Shaka Player
   authority:  ◀──data    id 101 (bin) ──▶   scheme.ts ──▶ mesh.fetch ──▶ peer | host
   state, bytes,                               │
   tracker, barrier                            ▼ guest-to-guest segReq/SegData (mesh.ts, LRU 64 MB)
```

| Boundary        | Transport                                                                                                                          | What crosses it                                                                                                                                                                | Who can see / inject                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Signaling       | trystero over 5 public Nostr relays + 4 public MQTT brokers (`rendezvous/trystero.ts`); localhost relay in tests only (`?s=local`) | topic = `sha1("Trystero@syncstream@CODE")`, per-page `selfId`, SDP/ICE **encrypted** with key = `SHA-256(":syncstream:CODE")`, timestamps. Never display names, MPD, or media. | Relay operators and any subscriber see hashed topics and peer ids; the code is recoverable offline from the hash (F-01).      |
| STUN            | Google x3, Cloudflare (`rtc/ice.ts:16-20`)                                                                                         | binding requests                                                                                                                                                               | STUN operators learn public IP:port. Not a media relay.                                                                       |
| Direct media    | DTLS/SCTP data channels on trystero's `RTCPeerConnection`; two negotiated channels (`rtc/channel.ts`)                              | control JSON (hello, ready{mpd}, state, intent, status, roster, ...) and 64 KB SegData frames                                                                                  | Any peer holding the code. Transport is encrypted; participants are **not authenticated** (PLAN §4.7, by design).             |
| Guest-to-guest  | same channels between guests (`mesh/mesh.ts`)                                                                                      | segReq/SegData for cached segments; `have`/`sourcesReq` to the host tracker                                                                                                    | Peer bytes are **unverified** (content-addressed by convention, no digest) - documented.                                      |
| TURN (optional) | `PUBLIC_TURN_*` baked into the static bundle; `iceTransportPolicy` stays `all`                                                     | would relay every byte of a relayed pair                                                                                                                                       | Absent by default; deploy.yml sets none. Enabling it breaks the strict no-intermediary-media property for relayed peers only. |
| Static host     | GitHub Pages                                                                                                                       | app shell only; `static.spec.ts` asserts no server entry, no non-GET to own origin                                                                                             | ordinary HTTP metadata                                                                                                        |

**Where strict no-media-relay limits connectivity.** With STUN only, a host
and guest behind symmetric NAT / CGNAT (and many corporate networks) cannot
form a direct pair; the connection fails and the guest is told so
(`WaitingRoom.svelte` "unreachable" phase). This is the product's deliberate
trade (PLAN §9) and this review does not propose changing it. What it does
find is that the **evidence** behind that screen is weaker than the copy
claims (F-13): a 15 s discovery timer, a vanished host, or another guest's SDP
are all reported as "needed TURN".

Trust model as implemented (PLAN §4.7 is accurate): the 6-character code
(32^6 = 2^30) is the only credential; the first peer to say `hello role:host`
is followed; later claims queue; no `password` is used; mesh bytes are
unverified. PLAN §4.7 already names trystero `password` as the mechanism a
stronger room would need.

---

## 2. Product requirement coverage

| Requirement (README / PLAN)                                             | Status                           | Evidence                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Media starts before the file is read or transferred                     | **Verified**                     | Probe + source read only ftyp/moov (+avcC/hvcC): 2.1 MB of 2.18 GB before `ready`; 15.9 MB after first segment (`measure.ts`, re-run by coordinator and verifier). No whole-file loop.                                                                   |
| No backend; static files only                                           | **Verified**                     | `static.spec.ts` 4/4 pass; build has no server entry. Signaling uses third-party relays (not ours).                                                                                                                                                      |
| Media never touches a server                                            | **Verified** (default)           | No TURN configured; data channels only. Optional TURN would relay (documented).                                                                                                                                                                          |
| TTFF < 5 s on `large-2gb.mp4`                                           | **Failed today (3 of 4 runs)**   | 5538 / 3983 / 5228 / 5618 ms across four isolated runs by two reviewers. PLAN §11 claimed 3.1-4.9 s. Uncontrolled machine load; not enough runs for a rate. The metric also excludes probe/createOrigin and is `loadeddata`, not a painted frame (T-02). |
| Seek < 2 s                                                              | **Untested** (test is invalid)   | `scale.spec.ts:64-93` measures `currentTime` assignment with a 10 s bound; PLAN's 43-45 ms is the intent round trip, not a landed seek (T-01).                                                                                                           |
| Peak RSS < 500 MB both sides                                            | **Untested** (test is invalid)   | `usedJSHeapSize` sampled once, `-1` sentinel passes, blind to ArrayBuffer backing stores and workers (T-03).                                                                                                                                             |
| Playback to completion, zero stalls                                     | **Failed**                       | The readiness barrier can deadlock the room in the last second of a film (F-02, Confirmed (Chromium) by two reviewers). No spec plays a film to `ended`.                                                                                                 |
| Drift < 100 ms p99 over 30 min, two machines                            | **Untested**                     | Single-sample `< 0.5 s` / `< 1 s` assertions on one machine (T-05).                                                                                                                                                                                      |
| Barrier trips on a slow guest and recovers                              | **Partial**                      | Trip is proven; the "recovery" assertion is satisfied by the pre-throttle seek (T-04). Browser run shows resume works in practice.                                                                                                                       |
| Tier classification names the real cause                                | **Partial**                      | AC-3, HEVC, sparse-keyframe, container sniffing: verified. fMP4 is accepted by the probe and then rejected with an internal string (F-07).                                                                                                               |
| Codec capability checked per side                                       | **Partial**                      | Host-only probe; Shaka filters guest-side. A guest that cannot play rep 0 has all restrictions cleared while only `[0]` is advertised (F-10); a guest whose player fails to load holds the room (F-08).                                                  |
| Guest throttled to 1.5 Mbps keeps playing on a rung; recovers to native | **Verified** (app-level shaping) | `media.spec.ts`, `abr-recovery.spec.ts` pass. Shaping is the app's own outbound token bucket, not a shaped link (correctly stated in PLAN §11). Recovery bound in test is 60 s vs PLAN "~15 s".                                                          |
| Phase 5: 4 guests hold native on a 12 Mbps uplink                       | **Failed (documented)**          | `mesh.spec.ts:198 test.fail()`; ran as expected failure today. Peer path moves bytes with zero fallbacks; host load is not reduced (PLAN §11).                                                                                                           |
| Host departure ends the room for guests, host return resumes            | **Verified**                     | `waiting.spec.ts`, `host-return.spec.ts` pass on the local relay.                                                                                                                                                                                        |
| File replacement without ending the room                                | **Partial**                      | Works when `createOrigin` succeeds; a failing second file tears down the first with no message (F-06); the stale tracker can serve old-film bytes (F-04); an identical MPD suppresses the switch (F-05).                                                 |
| iOS / Safari / Firefox guests                                           | **Untested**                     | Chromium only, one machine.                                                                                                                                                                                                                              |
| Real NAT / cross-network / TURN                                         | **Untested**                     | `unreachable.spec.ts` forces `iceTransportPolicy: relay` with no TURN on localhost.                                                                                                                                                                      |

---

## 3. Findings

Severity: Critical / High / Medium / Low / Info. "Repro" names the script or
run in §6. Verifier verdicts are in §7; severities below are post-verification.

### Confirmed bugs

#### F-01 Room code is recoverable offline from relay traffic; the SDP key derives from the same code

- Severity **Medium** (High consequence for confidential films) - **Confirmed (module)** - security / privacy - classification: **documented trust limitation, now demonstrated**
- Evidence: `node_modules/@trystero-p2p/core/dist/strategy.mjs:81-85` `sha1(topicPath(libName, appId, roomId))` and key via `genKey(password ?? '', appId, roomId)`; `crypto.mjs:11-13`; `src/lib/rendezvous/trystero.ts:290-293, 313-316` join without `password`; `src/lib/rendezvous/codes.ts:16-17` 32-char alphabet, length 6. PLAN §4.7 states the code is the only credential and that a stronger room "would need a secret the relay never sees, which trystero's `password` option provides and this build does not use"; what it does not say is that the credential is recoverable by third parties from the hashed topic.
- Trigger: subscribe to the public Nostr kinds / MQTT `#`, take any observed topic, brute-force `sha1("Trystero@syncstream@" + c)` over 2^30 candidates.
- Impact (enabled, not observed): a relay operator or passive subscriber enumerates live rooms, recovers codes, decrypts SDP (public IPs), joins as a guest and pulls the film, or queues a host claim for the next host reload.
- Repro: `conn/topic.ts` - 1.8 M SHA-1/s on one core (exhaustive ~10 min single-core; multi-core/GPU figures are extrapolations); recovers a fresh code from its topic with 2 chars fixed in 0.5-1.0 s. Reproduced by coordinator, Codex connectivity, and verifier.
- Smallest fix: product decision first. If stronger privacy is wanted: a random >= 80-bit secret in the invite link **fragment** (not sent in HTTP requests; still visible to page JavaScript) passed as trystero `password` on every transport. Verifier confirmed (module) that a wrong secret cannot decrypt SDP. **Caveat:** the installed `handshake.mjs:9-26` authenticates only the responder to the initiator, so `password` alone does not reject every code-only participant in every peer ordering; verify or wrap mutual authentication before claiming so. Otherwise: document the offline-recovery property next to the existing trust-model text.
- Acceptance: topic + code alone cannot decrypt fresh SDP or activate a session in either peer ordering, including via a pre-existing shared peer; pasted invite still joins.

#### F-02 The readiness barrier can deadlock the room in the last second of a film

- Severity **High** - **Confirmed (Chromium, two independent runs) + Confirmed (module)** - correctness
- Evidence: `src/lib/media/shaka/config.ts:179-190` `playerBufferAhead` = `range.end - now` (remaining film, not buffer health; `0` when no range); `src/lib/sync/state.ts:441-445` `< BARRIER_LOW_SEC(1)` blocks, `> BARRIER_HIGH_SEC(5)` releases - impossible past the end; `src/lib/room/guest.ts:616-636` reports every 1 s with no end-of-stream exception and keeps the peer fresh (`state.ts:435-436`, so stale eviction cannot help); `host.ts:206-210` pauses.
- Trigger: a status tick lands while a guest has < 1 s of film left and the host has not yet `ended`. Any room with the barrier enabled (default) and at least one guest is exposed; a seek into the last seconds has the same shape.
- Observed: at 59.58 s (coordinator) / 59.81 s (verifier) of a 60 s film the host auto-paused with "Waiting for Guest N to catch up", the guest showed the banner, and the room stayed frozen before `ended` for the remaining ~25 s of sampling (93/114 and 91/115 samples). Only a manual play (override) or disabling the barrier gets past it. `control.ts:100-101` describes the intended behaviour ("a film that simply ended was not paused by anyone"); this violates it.
- Repro: `pw/review-repro.spec.ts` test 1 (both runs seek to T-6 s, so not an uninterrupted full watch); `sync/barrier.ts`; Codex `repro.ts` `EOF_BARRIER`.
- Smallest fix: an explicit end-of-stream-aware readiness: when the guest's buffered range reaches `video.duration - epsilon`, report a finite value above `BARRIER_HIGH_SEC` (e.g. `BARRIER_HIGH_SEC + 1`) or an explicit `atEnd` flag the barrier treats as ready. **Not `Infinity`/`NaN`:** `Number.isFinite` skips both (preserving a blocking verdict) and JSON serialises `Infinity` to `null` (verifier, module).
- Acceptance: tiny-60s plays to `ended` on host and guest with the barrier enabled and `waitingOn` stays empty through the end; a seek into the last 1 s and last 4 s completes; a genuinely truncated stream still blocks.

#### F-03 Any connected peer can make the host (or a guest) retain unbounded partial segment data

- Severity **High** - **Confirmed (module)** - resource / security
- Evidence: `src/lib/rtc/channel.ts:306-324` every SegData frame is pushed into the Reassembler before any ownership check; `src/lib/protocol/wire.ts:95-137` one entry per `requestId`, no cap on entry count or total bytes (`MAX_PAYLOAD_BYTES` bounds only one entry's chunk count), no check that a chunk is <= `CHUNK_BYTES`, no check that `totalChunks` is consistent across frames (a disagreeing frame throws inside the concat loop and leaves the entry pending; `channel.ts:319-322` swallows it). Ownership is checked only after full reassembly (`guest.ts:575-576`, `mesh.ts:768-771`). The host **does** register a segment subscriber through its mesh (`mesh.ts:812`, `:768`), so subscriber-count gating is not a fix (verifier correction to the draft).
- Trigger: one peer sends chunk 0 of a 2-chunk transfer under fresh requestIds, or zero-byte frames each claiming 4096 chunks.
- Impact: host tab (serving everyone) or victim guest grows until it dies; the room ends. Browser OOM not forced; Bun heap growth measured.
- Repro: `conn/reassembler.ts` - 200k partial 1 KB frames: +236 MB heap; 50k zero-byte frames claiming 4096 chunks: **+1.34 GB** (~2157x amplification per wire byte); mismatched totals leak the entry. Re-run by verifier with identical numbers; Codex connectivity reproduced independently (65537-byte chunk accepted).
- Smallest fix: admit frames only for requestIds this link is currently awaiting (host: none for guests' SegData), before allocation; cap pending entries and total pending bytes per link with oldest-first eviction; record `totalChunks` per entry and drop disagreeing frames; reject chunks > `CHUNK_BYTES`; dispose partial state on malformed framing.
- Acceptance: unsolicited/invalid frames allocate no retained state; adversarial partial traffic stays under the per-link cap; `seek-cancel.spec.ts` still green.

#### F-04 After "Change video", the host tracker points new-film requests at peers holding old-film bytes under the same key; the wrong bytes are then cached

- Severity **High** - **Confirmed (module, real mesh module)** - correctness
- Evidence: `src/lib/room/host.ts:590-649` `setFile` replaces `origin`, `title`, `pausedBy` but never touches `mesh` (created once at `host.ts:171-181`); `mesh.ts:1088-1133` tracker keyed by `repId/track/segIdx` (`control.ts:225-226`) with no film identity; the guest cache lives until `stopPlayback` finishes `await old.destroy()` behind any earlier queued load (`guest.ts:299-312, 378-382`) and keeps serving (`guest.ts:544-550`); `mesh.ts:855-865` admits and **caches** any well-formed fragment before returning it, so a retry is served from the poisoned cache (`:837-839`). The comment at `mesh.ts:292-294` (downstream rejection penalises the peer and retries the host) describes a feedback path that does not exist.
- Trigger: host switches film A -> B while guest G1 still holds A's cache; G2 on B asks `sourcesReq 0/video/3`, is pointed at G1, receives A's segment 3, caches it. No malicious input needed; two guests with different control latency suffice. The window is not bounded by any generation transition.
- Impact: wrong picture/audio for a segment, or an MSE append error, persisting across retries; no message.
- Repro: `sync/mesh-tracker.ts` (host side); Codex `repro.ts` drives the real mesh end to end: requester receives tag 65 (old film) with `hostFetches=0, fallbacks=0`, retry returns the same cached bytes. Verifier re-ran it. Rendered wrong frames in a browser not exercised.
- Smallest fix: a host-issued film generation in `ready`, `segKey`, `have`, `segReq`; ignore cross-generation traffic; reset the tracker in `setFile` (necessary but alone insufficient: late old-film `have` refills it).
- Acceptance: two compatible films, three guests, one guest's `ready` handling delayed; every byte G2 appends belongs to B, including retries; stale A `have`/`segReq` are ignored.

#### F-05 An identical MPD suppresses a genuine film replacement on the same host page

- Severity **Medium** - **Confirmed (static + deterministic MPD, module)** - correctness
- Evidence: `src/lib/room/guest.ts:315-317` `if (loadedMpd === mpd) return;`; `manifest.ts:317-361` emits no file id, title, or digest; `origin.ts:77-94` builds from track metadata only; `guest.ts:368-369` title/onReady update only after the guard.
- Trigger: host picks a renamed copy of the same file, or a different file with identical emitted metadata.
- Impact: guest keeps the old title; for metadata-identical content it keeps the old player and cache while the host plays the new one.
- Repro: Codex `repro.ts` `MPD_HAS_NO_FILE_ID true`; guest path static.
- Smallest fix: dedupe `ready` by the film generation from F-04, not by manifest text.

#### F-06 `setFile` tears the live film down before `createOrigin` can fail; nobody is told

- Severity **High** - **Confirmed (static; verifier upgraded from Likely)** - reliability / diagnostics
- Evidence: `src/lib/room/host.ts:603` `title = ...`, `:608` `pausedBy = null`, `:610` `origin?.close()`, `:611` `await stopOwnPlayback()`, `:612` `const next = await createOrigin(...)`, `:613` `origin = next` only on success; only the `reject` tier broadcasts `unplayable` (`:594-597`). `sendReady` (`:333-342`) reads the still-non-null **closed** origin's MPD and the **new** title for any peer arriving or saying hello (`:402-422, 507-518`) - during construction and after a throw.
- Trigger: a second file whose probe is not `reject` but whose `createOrigin` throws: fMP4 (F-07), 4K HEVC with no H.264 encoder for the level (`origin.ts:54-67`), "encoder could not start" (`origin.ts:46-48`), moov not found in head/64 MB tail (`source.ts:212`).
- Impact: the running film's origin is closed and unusable (`segErr` "source: closed" / "ladder is closed"); the host's own element has lost its src; guests' Shaka retries then errors generically; a late joiner receives the closed origin's MPD under the new title. The host sees a red banner with an internal string. Note that a bare `unplayable` broadcast would **not** be visible to a guest mid-film: `+page.svelte:250-255` gives `ready` precedence over `rejected`.
- Smallest fix: build `next` first; on throw leave `origin`, `title`, `pausedBy` and own playback untouched and surface a non-fatal "could not switch to <file>: <reason>" to host and guests (a message the room page renders during playback); only on success close the old origin.
- Acceptance: host plays tiny-60s, then picks an fMP4; host and guests keep playing the first film, every screen names the cause, a late joiner gets the first film's MPD and title.

#### F-07 Fragmented MP4 is probed `direct`, then rejected with an internal string

- Severity **Medium** - **Confirmed (module)** - diagnostics
- Evidence: `src/lib/media/probe.ts:706-771` never checks `info.isFragmented`; `src/lib/media/source.ts:470-477` throws `'source: this file is already fragmented (fMP4), which the passthrough origin cannot index'`.
- Trigger: an fMP4/CMAF `.mp4` whose codecs would otherwise pass (ffmpeg `-movflags frag_keyframe+empty_moov`, recorded MSE streams).
- Impact: picker says "streams untouched", then shows a developer string; combined with F-06 it kills a running film.
- Repro: `orca/scratch/media-resources/measure.ts frag.mp4` -> `tier: direct` then `createOrigin threw: ...already fragmented...` (`isTypeSupported` stubbed true; the container mismatch is what is proven). Re-run by coordinator and verifier.
- Smallest fix: `probeFile` rejects `isFragmented` with a sentence naming the cause and `ffmpeg -c copy -movflags +faststart` as the remedy, next to the other container verdicts (`probe.ts:654-669`).

#### F-08 A guest whose player failed to load holds the whole room at the barrier, and the room blames its connection

- Severity **High** - **Likely** (status/barrier mechanism Confirmed (module); end-to-end not run) - reliability / diagnostics
- Evidence: `src/lib/room/guest.ts:333` `player = await createPlayer(...)` before `load`; `:350-358` load rejection thrown to `queuePlayback`'s catch, which only reports (`:378-382`); `:616-636` status timer skips only when `!hostLink || !player`, so it keeps sending `bufferedAhead: 0` (`config.ts:183-189` returns exactly `0` with no range - verifier confirmed); `state.ts:441-445` marks it blocking. No guest->host "cannot play" message exists.
- Trigger: `player.load` fails after construction: no playable variant (host passes through AC-3/E-AC-3 audio with a single audio rep; HEVC video before any rung is warm), Shaka error 4032.
- Impact: the guest sees "This browser can't play the format this video is in" (no codec named); everyone else sees "Waiting for Guest N to catch up" and the film pauses for all, indefinitely; override lasts until the next seek (`rearm`).
- Smallest fix: on `startPlayback` failure, stop the status tick for that guest **and** remove it from barrier participation explicitly (reporting `NaN` is insufficient: it preserves an existing blocking verdict and refreshes liveness - verifier, module); add a `status.cannotPlay` reason so the host can say "Guest N can't play this format" and the guest message can name the codec from the MPD.
- Acceptance: force a load failure after at least one zero report; the failed guest is named accurately, the others keep advancing.

#### F-09 Negative composition offsets are written unsigned in a version-0 `trun`: corrupt rep 0 for ctts-v1 files

- Severity **Medium** - **Confirmed (module: generated bytes)** - correctness
- Evidence: `src/lib/media/source.ts:710-725` returns `createFragment` bytes untouched; mp4box `createFragment` (`node_modules/mp4box/dist/styp-9TIZZDLN.mjs:5999-6029`) calls `createMoof`, which sets CTS flags and stores signed `cts - dts` without changing the box version (`:7071-7098`); the writer uses `Uint32` for version 0 (`:5351`) and the reader likewise (`:5327`). `encode.worker.ts:507-535` re-demuxes the same bytes, so rungs inherit it.
- Trigger: MP4 with `ctts` v1 and negative offsets (ffmpeg `-movflags negative_cts_offsets`, some GPAC/other muxers). The host plays it fine off disk (direct tier); only guests consume the fragments.
- Impact: `-512` becomes `4294966784` ticks (seconds depend on timescale). Guest decode errors / stalls are the expected consequence but were **not** reproduced in a browser.
- Repro: `media/trun-cts.ts media/neg-cts.mp4` -> `#2 cts_offset(u32)=4294966784 (as i32 -512)`; control `tiny-60s.mp4` positive only. Re-run by verifier.
- Smallest fix: after `createFragment`, if any `cts < dts` in the segment, set the `trun` version byte to 1 (the written two's-complement bytes are already correct); add a negative-cts fixture and play it on a guest.

#### F-10 A guest that cannot decode rep 0 has every restriction cleared while only `[0]` is advertised

- Severity **Medium** - **Confirmed (module: configuration result)** - performance / correctness
- Evidence: `src/lib/media/shaka/config.ts:144-166` `heights` from `getVariantTracks()` (Shaka already dropped HEVC); `available` is empty while the host advertises `[0]` (`ladder.ts:139, 191-227` warm top-down), so `:164` configures `{minHeight: 0, maxHeight: Infinity}` (verifier reproduced with 720/480/360 variants and `[0]`); `guest.ts:363, 496-500` apply it; the MPD lists every rung including cold ones (`origin.ts:25-29`). The first variant choice happens at `player.load` (`guest.ts:352`), before the post-load clamp at `:363`, so changing this branch alone does not control the first pick.
- Trigger: HEVC host (hevc.mp4, real-movie.mp4 `hev1.2.4.L120.90`), guest without HEVC MSE.
- Impact: cold H.264 rungs are selectable during warm-up; the PLAN §4.2 "cold rung read as congestion" sequence is the expected consequence but its magnitude is **not measured**. `codec-asymmetry.spec.ts:24-30` waits only for host `tier === 'direct'` and asserts `rung > 0` within 60 s; it neither controls nor asserts warmth.
- Smallest fix: decide the policy: either hold the guest's first selection until a supported rung is advertised warm (strict warm-only) or deliberately pay one cold rung by restricting to the **smallest supported** height; implement it before the first `load`, not only after.

#### F-11 Host serves `segReq` with no concurrency or admission cap; encode jobs are never cancelled

- Severity **High** (verifier: same participant boundary as F-03) - **Confirmed (static)** - resource
- Evidence: `src/lib/room/host.ts:361-381` `serving` is a gauge only; `:443-451` `void serveSegment(link, msg)` per message and `segCancel` aborts only the send; `channel.ts:418-424` keeps views of the full payload across gate waits, so LRU eviction (`source.ts:145-162`) cannot free a buffer still referenced by a pending send; `ladder.ts:266-295` `request()` has no depth cap, `:480-493` `focus = segIdx` before any range check (poisons `getInit` for other guests); `source.ts:755-779` dedupes same-key work but not distinct keys; `MAX_OUTSTANDING_PER_PEER = 3` (`mesh.ts:105`) is requester-side only. The duration-derived `maxSegIdx` (`ladder.ts:114-121`) is a soft bound, not the exact source bound.
- Trigger: one guest (needs only the code) sends segReq for seg 0..N of rep 0 or rung 3 without awaiting replies; a Shaka retry storm; one bogus huge `segIdx`.
- Impact: retained send payloads can approach much of the file outside the 200 MB LRU (large-2gb: 450 video segments, 2.175 GB total, ~4.8 MB average per segment interval - the draft's "2.6 GB" was an extrapolation from the first segment and is withdrawn); one guest can keep the 1-2 encode workers busy transcoding at demand priority, starving the host's own tier-2 playback and friends' rungs. Peak browser memory not measured. Four independent reports reached the same conclusion.
- Smallest fix: validate `track`, `repId`, and exact `segIdx` bounds before `note`/`request`/`focus`; per-link in-flight cap (Shaka needs <= 4) answering excess with `segErr`; drop a not-yet-started encode job on `segCancel` or peer departure when no other waiter.
- Acceptance: a burst of valid and invalid requests stays within a stated fixed work/byte cap and the host's own playback keeps advancing; out-of-range indices queue no encode.

#### F-12 Host-side `candidateType` is read before `getStats` resolves and never refreshed

- Severity **Medium** - **Confirmed (Chromium, two runs)** - diagnostics
- Evidence: `src/lib/rtc/connection.ts:153-158` resolves `link.candidateType` asynchronously; `:203-205` `readCandidate(); ... cb(link)` announces synchronously; `src/lib/room/host.ts:508` copies the current value and the status handler (`:467-483`) never refreshes it; `guest.ts:628` refreshes the guest's own value every second.
- Observed: host `peers[].candidateType = ["unknown"]` while the same guest reads `host` / `connected`, in both the coordinator's and the verifier's runs. The ICE listener at `connection.ts:177` can fire before announcement in some orderings, so "always unknown" exceeds the evidence.
- Impact: README's "read candidate type on a real cross-network guest" still works on the **guest** page; the host's per-peer telemetry for PLAN §9 does not. One local type also describes only one end of the pair.
- Smallest fix: update the host's peer stat when `readCandidate`'s promise resolves (or on `status`); record both selected local and remote candidate types and classify a pair relayed if either side is `relay`.

#### F-13 "Unreachable / needed TURN" is partly a timer verdict; a found-but-silent host has no diagnosis at all

- Severity **Medium** - **Confirmed (static)** - diagnostics / liveness
- Evidence: `src/lib/rendezvous/room.ts:329` `onPeerJoin(() => finish(resolve))` settles on **any** peer (another guest); `:331-350` 15 s after 'discovered' rejects `PeerUnreachable` regardless of pc state; `:352-353` 'connected' only counts; `guest.ts:115` maps `UnreachableError` to `stats.iceState = 'failed'`; `README.md:88-89` reads that as "this connection needed TURN"; `guest.ts:128, 438-470` adopt a host only on a host-role hello; `+page.svelte:245-255` derives searching/found with no post-rendezvous deadline; `WaitingRoom.svelte` (whole file) has no timer and asserts "the host answered" at `:204-206`.
- Trigger: (a) a guest reaches a surviving guest but no host (host closed, one guest stayed, a second joins) -> "Looking for room X" with no application deadline; (b) host closes after its offer reached the guest -> "your two networks wouldn't let a direct connection through"; (c) pc connects but SCTP stalls -> "unreachable".
- Impact: wrong advice, over-counted "needed TURN" telemetry, an unbounded spinner in case (a). Verified statically by three reviewers; the browser sequence was not run.
- Smallest fix: carry the cause in `PeerUnreachable` (deadline vs observed `connectionState`/`iceConnectionState`), set `stats.iceState` only from observed state; add a bounded host-hello phase after rendezvous ("found people in the room, but not the host") with retry/home.

#### F-14 A stalled host makes every guest replay the same second in a hard-seek loop

- Severity **Medium** - **Confirmed (module)** - correctness
- Evidence: `src/lib/sync/state.ts:133-134` `playing: !paused`, `mediaTime: currentTime` - a buffering host is `playing: true` at a frozen position every heartbeat; `:281-291` guests extrapolate then hard-seek back; `:71` `ANCHOR_EVENTS` lacks `waiting`/`stalled`.
- Trigger: tier-2 host whose encoder is behind (`host.ts:562-588`), slow disk, decoder hiccup, any stall > 1 s.
- Repro: `sync/host-stall.ts` -> 3 hard seeks `101.0 -> 100.0` in a 3.3 s stall; Codex `HOST_STALL_EXTRAPOLATES`.
- Smallest fix: report `playing: !paused && readyState >= HAVE_FUTURE_DATA` and add `waiting` to `ANCHOR_EVENTS`.

#### F-15 A pending seek blocks newer seeks and even an authoritative pause

- Severity **Medium** - **Confirmed (module)** - correctness
- Evidence: `src/lib/sync/state.ts:262` `if (this.video.seeking || readyState < HAVE_METADATA) return;` precedes `follow(s)` at `:286`; a host fetch for the seek target can take up to 60 s (`guest.ts:195-197`).
- Repro: Codex `SEEKING_SUPPRESSES_NEW_STATE {time:20, paused:true, lastSeq:2}`.
- Smallest fix: apply play/pause before the seeking guard; let a newer seek target supersede an in-flight one.

#### F-16 Lifecycle: orphaned host room on early navigation; leaked timers on normal close

- Severity **Medium** (orphan room) / **Low** (timers) - **Confirmed (static)** - reliability / resource
- Abort during the occupancy probe orphans a fully built, announcing host room: `host.ts:135-149` `await sleep(1500)` is not abort-aware and `startHostRoom` never re-checks `opts.signal`; `+page.svelte:313-317` aborts while `host` is still null; `room.ts:265-271` returns after the predicate without a cancellation check.
- `guest.close()` does not cancel a queued `startPlayback` (`guest.ts:327-341, 653-664`; no `closed` flag): a live Shaka player can be created after close and the global scheme re-registered.
- `host.close()` never calls `barrier.stop()`: `host.ts:680-688` vs `state.ts:380, 462-467` (no caller anywhere).
- `guest.close()` rejects `pending` without `p.cleanup()`: `guest.ts:662-663` vs `:260-263`; one 500 ms interval per in-flight host fetch survives.
- Smallest fixes: check `signal.aborted` after the probe and close `net`/leave; a `closed` flag re-checked after each await in `startPlayback`; `barrier.stop()` in close; settle pending through `settle()`.

#### F-17 `rearm()` re-pauses the room at the instant of a seek on pre-seek evidence

- Severity **Low** - **Confirmed (module)** - correctness (introduced by `b83100c`)
- Evidence: `state.ts:412-416` `rearm()` evaluates immediately; `override()` emptied `announced` (`:400`), so `onPause` fires on the straggler's last pre-seek report; `host.ts:274` runs before `state.applyIntent`.
- Repro: `sync/barrier.ts` `overridden; rearm() -> PAUSE at 0.0s`.
- Smallest fix: `rearm()` clears each peer's `blocking` verdict and lets the next report decide.

#### F-18 Audio AdaptationSet lists one `Representation id="0"` per ladder row

- Severity **Low** - **Confirmed (module)** - correctness
- Evidence: `src/lib/media/origin.ts:69-75` maps `LADDER` for audio; `ladder.ts:526-550` returns `NATIVE_REP` for every id. Observed: four identical `<Representation id="0" codecs="mp4a.40.2" ...>` (`orca/scratch/media-resources/mpd.ts`).
- Smallest fix: `audioReps = [ladder.representation(NATIVE_REP, 'audio')]`.

#### F-19 Guest-side names and arrays from the adopted host are rendered unvalidated

- Severity **Low** - **Confirmed (static)** - correctness / security
- Evidence: `guest.ts` 'hello'/'rename'/'roster'/'waiting'/'paused' pass `msg.name`, `msg.guests`, `msg.on`, `msg.by` straight to callbacks; `+page.svelte:111` `[company.host, ...company.guests]` throws on a non-iterable; `identity.ts:50-53` `remoteName` is used only on the host (`host.ts:355-359`); `naming.spec.ts:130-180` forges toward the host only.
- Smallest fix: route every incoming name through `remoteName`; `Array.isArray`-guard roster/waiting/rungs.

#### F-20 Late joiner buffers position 0 first; TTFF is marked on a frame nobody watches

- Severity **Low** - **Confirmed (Chromium; impact downgraded from the specialist's claim)** - performance / telemetry
- Evidence: `guest.ts:333-352` `player.load(blob)` with no start time although the host's `state` has arrived; `:366-367` clock/sync start after load; `:365` `loadeddata` marks TTFF.
- Observed (both runs): guest `readyState >= 2` at 0.0 s ~1.8 s after join (segment 0 fetched and appended), hard seek to the host position at 3.8-4.3 s while still paused, playing at ~5.6 s. The specialist's "plays from 0:00" was **not** reproduced; the wasted segment-0 fetch, ~2 s of extra join latency, and under-reported TTFF are.
- Smallest fix: pass a start time derived from `sync.lastState` to `player.load(blob, startTime)`.

#### F-21 README documents a Supabase strategy that no longer exists

- Severity **Low** - **Confirmed (static)** - documentation
- `README.md:73-80` vs `src/lib/rendezvous/transport.ts:13, 33` (`'nostr' | 'mqtt' | 'local'`, order `['nostr','mqtt']`). Credentials have no effect.

### Documented limitations (by design; listed so they are not re-litigated)

- Room code is the only credential; anyone holding it can join and claim host; mesh bytes unverified; `password` not used (PLAN §4.7). F-01 adds the measured offline-recovery cost.
- No TURN by default; symmetric NAT / CGNAT guests cannot connect (PLAN §9). Accurate; diagnosis quality is F-13.
- Phase 5 criterion unmet; `mesh.spec.ts:198 test.fail()` (PLAN §11). Ran today as expected failure. Peer path is correct; host uplink is not reduced.
- Occupancy check best-effort (PLAN §4.7).
- No "you are hosting, leaving ends the party" prompt (trystero tears down on `beforeunload`).
- CI runs without `large-2gb.mp4` / `real-movie.mp4`; scale/mesh/abr-recovery/real-movie skip there (they ran here).
- Straggler rendezvous strategies keep their relay sockets for the page lifetime (trystero's relay manager has no close).
- Hardware media keys / native pause on a guest are undone within 250 ms (no local pause by design).

### Hypotheses (not findings; each names the experiment that would settle it)

- H-1 Encoded rungs lose RASL leading pictures at open-GOP segment starts (x265 default): a `k`-frame hole per boundary on every rung (`encode.worker.ts:234-248`). Experiment: force a rung on an `--open-gop` fixture and check `video.buffered` gaps across 3 boundaries.
- H-2 Rotation (tkhd matrix) kept on rep 0, dropped on rungs (no `rotation` passed to mp4-muxer; no `matrix` handling in `src`). Experiment: `-display_rotation 90` fixture, compare `videoWidth/Height` on rung 2.
- H-3 Worker decode->encode has no backpressure; a slow software encoder can hold a GOP of raw frames (`encode.worker.ts:213-224`). Experiment: process RSS during a forced 4K transcode.
- H-4 No watchdog on a wedged decoder/encoder; one stuck `flush()` blocks the single-worker ladder forever (`ladder.ts:355`). Experiment: stub a worker that never replies.
- H-5 Background-tab timer throttling (1/min after 5 min hidden, non-audible) makes a hidden guest flap the barrier (`BARRIER_STALE_MS = 5000`). Barrier state machine reproduced (`sync/barrier.ts`: PAUSE 0.0 / RESUME 5.0 / PAUSE 6.2 / RESUME 12.0); browser cadence not measured.
- H-6 Autoplay-blocked guest sits silently paused (`state.ts:313-320` swallows `NotAllowedError`; suite runs with `--autoplay-policy=no-user-gesture-required`). Experiment: one guest without the flag.
- H-7 Nostr `since: now()` vs a guest whose wall clock is ahead: offers filtered until MQTT rescues 10 s later.
- H-8 Audio cold-start per transcoded segment (fresh `AudioDecoder`/`AudioEncoder` per job) -> boundary tick or priming shift. No spec checks audio continuity.
- H-9 ~40 ms audio lead on edit-list files whose audio pre-roll is shorter than the video lead-in (`source.ts:519-525`, acknowledged in code; measured 39 ms on real-movie.mp4).
- H-10 macOS sleep skews `nowMs()`; min-RTT window keeps a stale offset up to 32 s after wake.
- H-11 trystero's password handshake authenticates only the responder (`handshake.mjs:9-26`, verifier, module); whether this lets a code-only peer activate against a password-protected app via a shared overlapping peer is unverified. Relevant only if F-01's remedy is adopted.

---

## 4. Test validity

Environment for every spec: one machine, Chromium (`channel: 'chromium'`) only,
`--autoplay-policy=no-user-gesture-required`,
`--disable-features=WebRtcHideLocalIpsWithMdns`, local signaling relay for
everything except `rendezvous.spec.ts`, `retries: 0` (rendezvous: 2),
`workers: 1`. Guests are opened as **pages in the same BrowserContext** as the
host (`helpers.ts:165-175`), not separate contexts or devices. Throttling is
the app's own outbound token bucket (`channel.ts spend()`), which shapes SCTP
payload submission on the sender; it is not a shaped link and models no RTT,
loss, or asymmetry (PLAN §11 correction 2 says so correctly).

| ID   | Spec                                              | What the assertion proves                                                                                                                                                                                                                   | What it does not                                                                                                                                                                                          |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-01 | `scale.spec.ts:64-93` "seek"                      | `currentTime` enters `(898, 930)` within **10 s**                                                                                                                                                                                           | a landed seek (`seeked`, `readyState >= 2`, buffered at target); PLAN's **2 s**. The 43-45 ms in PLAN §11 / README is intent RTT + assignment. `edit-list.spec.ts` and `seek-cancel.spec.ts` do it right. |
| T-02 | `stats.ttff` (all TTFF asserts)                   | `markTtffStart()` at `guest.ts:331` (inside `startPlayback`, after any queued teardown) -> `loadeddata` (HAVE_CURRENT_DATA)                                                                                                                 | rendezvous, hello, probe, `createOrigin`, `ladder.ready()`; a painted frame (`requestVideoFrameCallback`). For a late joiner it marks position 0 (F-20).                                                  |
| T-03 | `scale.spec.ts:26-30, 79-92` memory               | one `usedJSHeapSize` sample `< 500 MB`; `-1` sentinel also passes                                                                                                                                                                           | peak; ArrayBuffer backing stores; workers; PLAN's "peak RSS". A CDP heap metric with ArrayBuffer accounting would still not be RSS.                                                                       |
| T-04 | `room.spec.ts:239-251` barrier recovery           | `waitingOn` empties; `videoTime > 0.5` (already true from the seek to 45)                                                                                                                                                                   | that the guest resumed, advanced, or re-synced; `HostState.resume()`'s `autoPaused` path.                                                                                                                 |
| T-05 | `room.spec.ts:66-71`, `clock.spec.ts:50-51` drift | one sample `< 0.5 s` / `< 1 s`                                                                                                                                                                                                              | PLAN's 100 ms p99 over 30 min with play/pause/seek churn on two machines.                                                                                                                                 |
| T-06 | `mesh.spec.ts:160-165` (pass)                     | `fromPeers > 0`, `uploaded > 0`, `fallbacks === 0`, no stall 30 s at **any** rung                                                                                                                                                           | host uplink reduction (no host `bytesSent`), coverage %, churn, file change with mesh live. `:198` is `test.fail()`.                                                                                      |
| T-07 | `media.spec.ts:246-278` "zero stalls"             | `videoTime` +1.5 s within 30 s and `bufferedAhead > 0`                                                                                                                                                                                      | a stall counter (`waiting` events); "480p" specifically; glitch-free switch.                                                                                                                              |
| T-08 | `codec-asymmetry.spec.ts:24-55`                   | guest-side Shaka filtering via JS shims of `isTypeSupported`/`decodingInfo`; `rung > 0` within 60 s after waiting only for host `tier === 'direct'`                                                                                         | rung warmth (neither controlled nor asserted - F-10); audio asymmetry; the no-fallback case (F-08); message quality.                                                                                      |
| T-09 | `unreachable.spec.ts:25-49`                       | `iceTransportPolicy: 'relay'` + no TURN -> unreachable phase, `iceState === 'failed'`                                                                                                                                                       | the 15 s-timer verdict vs an observed ICE failure (both pass); real NAT; that TURN would have fixed it.                                                                                                   |
| T-10 | `rendezvous.spec.ts`                              | both ends prefer nostr; hello both ways on the public ladder                                                                                                                                                                                | PLAN §8's "strategies disabled one at a time"; an MQTT-only room; relay outages.                                                                                                                          |
| T-11 | `abr-recovery.spec.ts:72`                         | back to rung 0 within **60 s**                                                                                                                                                                                                              | PLAN's "~15 s"; glitch-free switch.                                                                                                                                                                       |
| T-12 | fixtures                                          | `vfr.mp4`, `surround-5.1.mp4` are generated by `gen.sh` and loaded by **no spec**; `large-2gb.mp4` is faststart, baseline H.264 (no B-frames), mono; `real-movie.mp4` is direct tier here, so the transcode path never runs on real content | VFR, 5.1 downmix, B-frames at scale, tier 2 on a real film.                                                                                                                                               |
| T-13 | `host-return.spec.ts`                             | guest follows the new page within 5 s, `mediaTime < 10`                                                                                                                                                                                     | same-page reconnect path; a queued rival claim; ICE-timeout-only detection.                                                                                                                               |

Not covered by anything: Safari/iOS (ManagedMediaSource), Firefox, real NAT /
CGNAT, cross-network or two-machine runs, public-relay outages, background
tabs, laptop sleep, autoplay-blocked guests, rotation, fMP4, HDR, multiple
tracks, host CPU smoothness during transcode (PLAN Phase 4 criterion has no
spec), rendered-pixel oracles outside `edit-list.spec.ts`.

---

## 5. Test results (this review, this machine)

Toolchain (coordinator's shell): bun 1.4.2, node 26.11.1, Playwright 1.61.1,
Chromium channel (`chromium-1228`), ffmpeg 9.0.2. Ports 4173/4174 were free
before each run; every Playwright invocation built and served **this**
checkout itself (`vite build` then `vite preview --port 4173 --strictPort`,
plus the local relay on 4174). `caffeinate -i` wrapped the coordinator's
runs. Logs: `$CLAUDE_JOB_DIR/tmp/{check,lint,build,e2e-local,e2e-followup,e2e-repro}.log`
and the verifier's `orca/scratch/verifier/{scale,review-repro}.log`.

| Command                                                                            | Result                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run check`                                                                    | 0 errors, 0 warnings (591 files) - `check.log`                                                                                                                                                                                                                                                     |
| `bun run lint`                                                                     | prettier clean, eslint clean - `lint.log`                                                                                                                                                                                                                                                          |
| `bun run build` (BASE_PATH=/SyncStream)                                            | ok, 1.8 MB `build/` - `build.log`                                                                                                                                                                                                                                                                  |
| `bun run test:e2e -- --grep-invert rendezvous` (local relay, all fixtures present) | **77 passed, 1 failed, 17.0 min**. Failed: `scale.spec.ts` TTFF `5538 ms` > 5000 (fails at `:55`, before the seek/heap assertions). `mesh.spec.ts:185` ran as the declared expected failure and is counted among the 77. The three Orca workers were starting during this run (uncontrolled load). |
| `scale.spec.ts` alone, x2 (coordinator)                                            | run 1 **pass**, TTFF `3983 ms` (seek-assignment 68 ms, heap host 82 / guest 14 MB); run 2 **fail**, TTFF `5228 ms`.                                                                                                                                                                                |
| `scale.spec.ts` alone (verifier, independent)                                      | **fail**, TTFF `5618 ms`; load averages 1.5 / 1.3 / 2.1 before the run.                                                                                                                                                                                                                            |
| `rendezvous.spec.ts` (public Nostr/MQTT)                                           | 1 passed, test 4.6 s (invocation 9.3 s), no retry needed.                                                                                                                                                                                                                                          |
| temp `pw/review-repro.spec.ts` (2 observational tests)                             | coordinator and verifier runs both completed; observations recorded under F-02, F-12, F-20. The tests end in `expect(true)` and are not acceptance tests.                                                                                                                                          |

TTFF across four isolated runs by two reviewers: fail / pass / fail / fail.
Not enough to estimate a rate or attribute cause (machine load was not
controlled); enough to say the 5 s bar is not reliably met today.

Skipped / expected: none skipped (both gitignored fixtures exist here); on CI
`scale`, `abr-recovery`, `mesh`, `real-movie` skip by design. One expected
failure (`mesh.spec.ts:198`). **Environmental failures (recorded, not
hidden):** the first attempt to run the temporary reproduction config failed
with `Cannot find module '@playwright/test'` (config outside the repo's
`node_modules`), then with `Script not found "build"` (webServer `cwd`), then
with a CJS `import.meta` error (no `"type": "module"` in the tmp dir); all
three were setup errors in the review's own scaffolding, fixed by a
`node_modules` symlink, a `cwd`, and a tmp `package.json`
(`e2e-followup.log`, `e2e-repro.log`). Unavailable: second machine,
Safari/iOS/Firefox, shaped network, TURN server, rendered-pixel oracle in the
temporary reproduction.

Public-rendezvous vs deterministic: only `rendezvous.spec.ts` touched public
relays; everything else used the localhost relay.

---

## 6. Reproduction artifacts (outside the repository)

All under `/Users/mio/.claude/jobs/22102697/tmp/`:

- `conn/topic.ts` - trystero topic/key derivation, SHA-1 rate, code recovery (F-01).
- `conn/reassembler.ts` - unbounded partial reassembly (F-03).
- `conn/control.ts` - `decodeControl` accepts malformed fields.
- `media/trun-cts.ts`, `media/neg-cts.mp4` - version-0 `trun` with negative cts (F-09).
- `media/trace-reads.ts`, `trace-probe.ts` - bytes read before `ready`, audio lead-in.
- `sync/host-stall.ts`, `late-join.ts`, `barrier.ts`, `mesh-tracker.ts`, `fake-video.ts` - F-14, F-20, F-02/F-17/H-5, F-04.
- `orca/scratch/media-resources/{measure,mpd,heap,grid,rot}.ts`, `frag.mp4`, `rot.mp4` - F-07, F-18, read accounting, H-2.
- `orca/scratch/connectivity-security/protocol-repro.ts`, `orca/scratch/sync-mesh/repro.ts` - Codex reproductions (F-03, F-04, F-14, F-15, F-02).
- `orca/scratch/verifier/extra.ts` + `extra.log` - verifier's checks (password handshake, barrier NaN/Infinity, restrictions with rep 0 absent, host segment subscriber count, large-fixture index).
- `pw/playwright.config.ts`, `pw/review-repro.spec.ts` - Chromium reproductions (F-02, F-12, F-20); logs `e2e-repro.log`, `orca/scratch/verifier/review-repro.log`.
- `e2e-local.log`, `e2e-followup.log`, `orca/scratch/verifier/scale.log` - suite and follow-up runs; failed scale trace copied to `orca/scratch/verifier/scale-test-results/`.
- `orca/reports/{connectivity-security,media-resources,sync-mesh,verifier}.md` - Orca specialist and verifier reports; the in-process specialist reports are in the session transcript.

---

## 7. Independent verification

Verifier: Codex GPT-6-Astra (Orca task `task_2213b89629e5`), read-only,
re-ran every module reproduction and two Chromium invocations, then
challenged classification and evidence. Overall verdict: **revise the review,
retain its principal correctness/resource findings.** Every correction below
has been applied to §§1-5.

| Item       | Verdict                            | What changed in this document                                                                                                                                                                                        |
| ---------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01       | revise                             | High -> Medium; reclassified as documented limitation now demonstrated; PLAN §4.7's `password` caveat quoted; remedy gains the responder-only-authentication caveat (H-11).                                          |
| F-02       | pass (core), revise wording/remedy | "every film" -> "can deadlock"; both Chromium runs cited; `Infinity`/`NaN` remedy withdrawn (not finite, JSON null); explicit end-aware readiness proposed.                                                          |
| F-03       | pass (core), revise                | "host registers no subscriber" withdrawn (mesh registers one at `mesh.ts:812`); remedy is admission before reassembly plus caps.                                                                                     |
| F-04       | pass; impact corrected             | "penalised honest peer" -> persistent cache poisoning on retry; `mesh.ts:292-294` comment noted as inaccurate; window not shown negligible.                                                                          |
| F-06       | pass; upgraded                     | Likely -> Confirmed (static); error-text and visibility qualifications added (`+page.svelte:250-255`).                                                                                                               |
| F-07       | pass                               | shim caveat added.                                                                                                                                                                                                   |
| F-08       | pass (premise), revise remedy      | `playerBufferAhead` returns 0 (not NaN) confirmed; NaN remedy withdrawn; explicit removal from barrier required.                                                                                                     |
| F-09       | pass; wording                      | mp4box line references corrected (createFragment `5999-6029`, createMoof `7071-7098`); browser consequences marked unverified.                                                                                       |
| F-10       | revise                             | ABR trajectory marked unmeasured; first-load-before-clamp noted; "smallest advertised" -> policy choice; T-08 corrected (spec waits for host tier, not warmth).                                                      |
| F-11       | revise                             | Medium -> High (same participant boundary as F-03); 2.6 GB extrapolation withdrawn, replaced by measured index (450 segments, 2.175 GB, ~4.8 MB avg); exact-bound note added.                                        |
| F-12       | pass; scope                        | "always unknown" softened; guest-page reading still works; both-ends note.                                                                                                                                           |
| F-13       | pass                               | -                                                                                                                                                                                                                    |
| F-16       | revise                             | orphan-host case raised to Medium.                                                                                                                                                                                   |
| T-01, T-03 | pass                               | RSS note added to T-03.                                                                                                                                                                                              |
| §4         | revise                             | "contexts" -> pages in the same context.                                                                                                                                                                             |
| §5         | revise                             | 3983 ms passing value and 5618 ms verifier run added; `MODULE_NOT_FOUND` and the other two scaffolding failures recorded; rendezvous test vs invocation time separated; check/lint/build claims now cite their logs. |
| T-02       | revise                             | anchor named as `markTtffStart()` at `guest.ts:331`.                                                                                                                                                                 |

Verifier's unverified list (adopted as this review's own): browser OOM from
F-03/F-11; rendered wrong-film frames for F-04; browser consequences of F-09;
ABR trajectory for F-10; the hostless-room sequence for F-13; the
password-handshake overlap exploit (H-11); everything in §4's "not covered".

---

## 8. Remediation plan (ordered; each tied to an acceptance criterion)

1. **F-02 end-of-film barrier** - end-aware readiness in `playerBufferAhead`
   (finite, above `BARRIER_HIGH_SEC`) or an `atEnd` flag; a spec that plays
   `tiny-60s.mp4` to `ended` on both sides with the barrier on, plus seeks into
   the last 1 s / 4 s. Acceptance: `waitingOn` empty through `ended`; a
   truncated stream still blocks.
2. **F-06 + F-07 setFile ordering and fMP4** - build the new origin before
   touching title/origin/playback; reject fMP4 in the probe with a remedy;
   render a non-fatal switch-failure message during playback. Acceptance: a
   failing second file leaves the first film playing everywhere and names the
   cause on every screen; late joiner gets the first film's MPD/title.
3. **F-03 + F-11 peer resource bounds** - admit SegData only for awaited
   requestIds; cap pending reassembly per link (entries and bytes); validate
   `totalChunks` consistency and chunk size; per-link in-flight `segReq` cap;
   validate `segIdx`/`track`/`repId` before `focus`/`request`; cancel
   unstarted encode jobs on `segCancel`/departure. Acceptance:
   `conn/reassembler.ts` stays under the cap; a 5000-request burst leaves
   <= K queued jobs and the host's own playback advancing;
   `seek-cancel.spec.ts` still green.
4. **F-04 + F-05 film generation** - host-issued generation in `ready`,
   `segKey`, `have`, `segReq`; tracker reset on `setFile`; dedupe `ready` by
   generation; fix the `mesh.ts:292-294` comment. Acceptance: the Codex
   `repro.ts` scenario returns only new-film bytes including on retry; a
   renamed copy switches title on every guest.
5. **F-08 cannot-play signalling** - failed-load guests leave barrier
   participation explicitly and the host names the format. Acceptance:
   forced load failure after a zero report; room keeps playing for others;
   both ends name the codec.
6. **F-13 + F-12 honest connectivity diagnostics** - cause-carrying
   `PeerUnreachable`, observed-only `iceState`, bounded host-hello phase,
   host-side candidateType refresh, both selected candidate types.
   Acceptance: timer vs ICE-failed distinguishable in `unreachable.spec.ts`;
   host overlay shows `host/srflx` for a LAN guest; hostless room reaches a
   terminal state within a stated budget.
7. **F-01 trust-model decision** - either document the offline-recovery
   property beside PLAN §4.7, or add the fragment secret with `password` and
   verify mutual authentication (H-11) before claiming code-only joiners are
   rejected.
8. **F-09, F-10, F-14, F-15, F-16, F-17, F-18, F-19, F-20** - small, local
   fixes listed per finding; F-16's orphan-room case first.
9. **Tests (T-01..T-08, T-12)** - landed-seek oracle at 2 s, process-memory
   peak (not JS heap), barrier-recovery delta, stall counter in stats,
   `requestVideoFrameCallback` for TTFF, specs for `vfr.mp4` and
   `surround-5.1.mp4`, a play-to-`ended` spec, a primary-disabled rendezvous
   fallback test. Then re-state PLAN §11 numbers from the new oracles.
10. **TTFF budget** - 3 of 4 runs missed 5 s today. Cheap wins identified:
    moov parsed twice (`probe.ts` + `source.ts`, ~0.2 s each on a 5 MB moov),
    serial `isConfigSupported` for 3 rungs x 6 configs before `ready`,
    warm-up encodes starting the instant `ready` is sent. Measure each with
    the corrected oracle over >= 10 runs on an idle machine before and after.

No rewrites and no new infrastructure are recommended: every item addresses a
measured or reproduced requirement failure within the existing architecture.

---

## 9. Five highest-value next actions

1. Fix F-02 (barrier at end of film) and add the play-to-`ended` spec. It is
   a small semantic bug that freezes a watch party 0.4 s before the credits
   with a false accusation, reproduced in Chromium by two independent runs.
2. Reorder `setFile` (F-06) and reject fMP4 in the probe (F-07): the current
   order silently kills a running film, which is the exact failure the
   project's Core Value names.
3. Bound what a peer can make the host do (F-03, F-11): admission-gated
   reassembly with byte caps, per-link `segReq` cap, index validation before
   `focus`/encode. Anyone with the invite link can currently take the host
   tab down.
4. Add a film generation to the segment namespace (F-04, F-05) so "Change
   video" cannot cross-feed old bytes (and cache them) or be swallowed by an
   identical MPD.
5. Make the acceptance tests measure what PLAN claims (T-01 landed seek,
   T-03 process memory, T-04 real recovery, T-02 painted frame) and run
   `scale.spec.ts` >= 10 times on an idle machine to decide whether the TTFF
   budget is actually exhausted before spending effort on it.

Decision needed from the product owner, not from this review: whether the
room code stays the only credential given F-01 (relay observers can recover
it offline in minutes), or whether the invite link carries a fragment secret
(with H-11 verified first).
