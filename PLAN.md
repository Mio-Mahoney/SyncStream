# SyncStream: Streaming Rebuild Plan

Status: built and verified (§11), usability layer merged (§12), finishing pass
landed (FINISH-PLAN.md). Sections 1-10 are the plan as decided; §11 records
what measurement did to it; §12 records the product the UI iterations built
around it.

## 1. Goal

A host opens a local MP4 in their browser. Guests join with a 6-character code or link and watch it together, in sync, with playback quality that adapts per guest to whatever their connection can actually carry. No uploads to a server, no re-encoding trips through the cloud, no waiting for a download to finish before the first frame.

**And: no infrastructure.** The site is static, the media is peer-to-peer, and the host's own uplink is the only transport. See §4.7.

## 2. Why the current build cannot get there

The hackathon build is a file transfer with a video player attached, not a stream.

In `src/routes/room/[id]/+page.svelte`, the host calls `reader.readAsArrayBuffer(file)` on the entire movie (line ~190), and on each guest connection sends that whole ArrayBuffer as one PeerJS message (line ~126). The guest accumulates every byte in memory, waits for the transfer to complete, and only then calls `URL.createObjectURL(new Blob(...))`.

For a 4GB file on a 20 Mbps uplink that is roughly 27 minutes before a single frame renders, repeated per guest, with both sides holding gigabytes of JS heap. There is no point in this design where quality adaptation is expressible: there is one message, and it either completes or it does not.

This is not a missing feature. The shape of the design has no room for the feature. The media path gets replaced.

## 3. The core inversion

**The host becomes an origin server for its own local file. Guests pull segments from it.**

The host never reads the whole file. It reads byte ranges on demand with `File.slice()` and packages them into CMAF segments in the browser. Guests request segments over a WebRTC data channel and play them through a standard ABR player.

This single inversion produces everything else:

| Property | Why it follows |
| --- | --- |
| Fast start | Play as soon as segment 0 lands, not the whole file |
| Seek | Request the segment containing the target timestamp |
| Bounded memory | Only the working set is resident, on both sides |
| **Adaptive bitrate** | Quality becomes a per-segment choice, which is the whole point |
| Mesh distribution | Segments are content-addressed, so any peer can serve them |
| **Zero infrastructure** | Media never touches a server, so there is nothing to pay for |

PeerJS is dropped entirely. Its `DataConnection` does its own serialization and chunking with no backpressure control, and that framing layer is exactly what is in the way. We use raw `RTCPeerConnection` with two channels and our own framing.

### Rejected alternative: `captureStream()` over a media track

Pipe `video.captureStream()` into an `RTCPeerConnection` media track and let WebRTC's congestion control do adaptation for free.

Rejected. It is live-only, so guests can never buffer ahead and any network dip is a visible glitch rather than a buffer drain. Every guest costs the host a full realtime encode. And it imposes generational quality loss on a file we already have in perfect quality on disk. It is the faster path to a demo and the wrong path to a product.

---

## 4. Decisions

These are settled. Recorded here so they are not relitigated mid-build.

### 4.1 Standard formats, not bespoke ones

**Target CMAF.** The requirement that every quality rung share identical segment boundaries and timescale is not a quirk of our design, it is the entire reason CMAF exists. Name it explicitly so the constraint is legible to anyone who touches this later: fMP4, keyframe-aligned, one init segment per representation, switchable at any segment boundary.

**The manifest is a DASH MPD.** The host parses its local file and generates a real MPD with a `SegmentTemplate`. We could invent a JSON manifest in an afternoon, and then own its edge cases forever. An MPD costs about the same to generate and is understood by every tool, every player, and every engineer who has done this before.

### 4.2 Shaka Player, not a hand-rolled player

**This is the single largest tech-debt reduction available and it deletes two of our modules.**

The original plan had us writing our own MSE buffer manager and our own ABR controller. That code looks fine in a demo and then generates edge-case bugs for years: MSE quirk handling across browsers, `QuotaExceededError` on append, buffer eviction, gap jumping across segment discontinuities, seeking into an unbuffered range, `SourceBuffer` update queuing, codec switch handling. Every one of those is a known problem that Shaka Player solved a decade ago and Google runs in production at YouTube scale.

Shaka supports exactly the integration we need. `shaka.net.NetworkingEngine.registerScheme()` installs a custom transport, so we register a `syncstream://` scheme whose handler maps a URI like `syncstream://rep/2/video/seg/17` onto a `segReq` over the data channel and resolves with the bytes. Shaka does not know or care that there is no HTTP involved. In exchange we get its ABR, its buffer management, its seek logic, and its browser quirk table for free.

Deleted from the plan as a result: `src/lib/media/player.ts`, `src/lib/media/abr.ts`, and the buffer-tracking half of the readiness barrier. We configure Shaka rather than reimplementing it.

We still own `source.ts` (the host origin) and `ladder.ts` (the transcoder), because those are genuinely ours. We own the transport and the sync engine. We do not own a media player.

**Known wrinkle, flagged honestly:** lazy rung generation (§4.5) means a rung may not exist when first requested, so the handler stalls while it encodes. Shaka's ABR estimator reads that latency as low throughput and may downshift away from a rung that is actually fine. Mitigation is to generate slightly ahead of the playhead and to serve a rung only once its first segments are ready. This interaction is the main risk of the Shaka integration and gets a dedicated test in Phase 4.

### 4.3 Probe and tier, not fail-loudly

When a file cannot be segmented, we do not fail and we do not blindly transcode. **We adopt the three-tier model that Plex and Jellyfin have run for over a decade**, because it is the shape of the problem:

| Tier | Condition | Cost |
| --- | --- | --- |
| **Direct** | Container segmentable, codecs browser-native | Zero, passthrough |
| **Transcode** | Codec unplayable, or segmentation fails | Host CPU |
| **Reject** | Even the decoder cannot open it | Clear error |

The decisive argument is that **Phase 4 builds the transcoder anyway** for the ABR ladder. Once WebCodecs is in the codebase, the fallback tier is not new machinery, it is rung generation with rep 0 pointed at the encoder instead of at passthrough. Choosing "fail loudly" would mean owning a transcoder and refusing to use it. That would be an absurd position to defend in six months.

A user whose file is rejected does not conclude the file is unusual. They conclude the product is broken and they do not come back.

**Sequencing:** the probe lands in Phase 2 and classifies honestly. Until Phase 4 exists, tier 2 reports "this file needs transcoding, which is not built yet" rather than "unsupported". Phases 2 and 3 develop against direct-play files, which is most of them.

### 4.4 Audio must be transcodable

MP4s remuxed from MKV sources very commonly carry AC-3, E-AC-3, or DTS audio. **No browser decodes those.** An earlier draft of this plan assumed audio is always passthrough, which would have produced silent video with no diagnostic on a large fraction of exactly the files people watch together.

Audio gets its own probe and its own transcode path to AAC via `AudioDecoder`/`AudioEncoder`. It is far cheaper than video transcoding and it is not optional. Audio is still never *re-encoded for bitrate reasons*, so there is one audio representation, but that representation may be a transcode rather than a passthrough. Video rung selection never affects audio.

### 4.5 Ladder

| id | resolution | video bitrate | source |
| --- | --- | --- | --- |
| 0 | native | native | passthrough, or transcode under §4.3 tier 2 |
| 1 | 1280x720 | 2.5 Mbps | encoded |
| 2 | 854x480 | 0.9 Mbps | encoded |
| 3 | 640x360 | 0.4 Mbps | encoded |

**H.264 (`avc1`) for every encoded rung.** It is the only codec with universally available hardware encode, and we are encoding in realtime on a machine that is simultaneously a participant. AV1 is better per bit and irrelevant until hardware AV1 encode is common; revisit then, and the ladder is data so it will be a config change.

**The 360p floor is deliberate.** The gap between the 480p rung and nothing is a stall, and a stall in a watch party pauses the whole room under the readiness barrier. Netflix's floor is around 235kbps for the same reason. Lazy generation means an unused rung costs nothing.

**Rungs are generated lazily and only on demand**, capped at 1-2 concurrent encodes, in a Worker. On the main thread the encode janks the host's own playback, which is unacceptable because the host is a participant and not a server.

### 4.6 Rendezvous: trystero with a strategy ladder

WebRTC needs an out-of-band channel to exchange SDP and ICE candidates. That is the *only* thing this project needs a third party for, and it is a few kilobytes per room, once, at join time.

**Use `trystero`.** It is one dependency exposing one `joinRoom()` API over pluggable backends (Supabase, Firebase, Nostr, MQTT, BitTorrent trackers). This matters: a multi-backend strategy is not multiple systems to maintain, it is a config list.

**Strategy ladder, in priority order:**

1. **Supabase Realtime** (free tier, operated, predictable)
2. **Nostr** (public relays, no quota)
3. **MQTT** (public brokers, no quota)

**Rendezvous protocol:**
- The **host announces on every strategy simultaneously.** Signaling is kilobytes, the host is one process, and this costs nothing.
- The **join link carries the host's primary strategy** (`/room/ABC123?s=supabase`). The host has connected before the link exists, so this is always known and correct.
- The **guest tries the link's strategy first, then falls through the ladder.** Rendezvous succeeds if any single backend works for both parties.

This is Happy Eyeballs, and it is the actual argument for the hybrid over any single backend. Supabase's free tier can be exhausted by our own success or by someone abusing the public anon key. Nostr relays come and go. Any one of them failing is survivable; all of them failing simultaneously is not a scenario worth designing against.

**Debt containment: this sits behind a `SignalingTransport` interface.** The decision is deliberately reversible. If free-tier rendezvous becomes untenable, a Cloudflare Worker with one Durable Object per room is a single-file swap that costs about $5/month flat. That escape hatch is what makes the free path safe to take, and it is the same reasoning that put `RoomStore` behind an interface in an earlier draft. The debt is never the implementation, it is the coupling.

**Critical constraint: trystero is used for rendezvous only.** Take the `RTCPeerConnection` it hands back from `room.getPeers()` and create our own data channels on it, with our own framing and backpressure per §7 Phase 1. **Do not send media through trystero's own data-channel API.** We are replacing PeerJS precisely because a convenience wrapper's opaque chunking with no backpressure is what broke the current build. Adopting a different wrapper with the same shape would reproduce the bug with a new name. Verifying that `getPeers()` exposes the raw connection is the first task of Phase 1, because the whole approach depends on it (§10).

**Supabase note:** the anon key ships in a static client, which is what it is for, but Realtime channel policies must be scoped so a stranger with the key cannot enumerate or hijack rooms.

### 4.7 No backend at all

Following from §4.6 and the deferred TURN decision (§9), **there is no server.**

- **Media** never touches infrastructure. The host's uplink is the transport, which is the whole point of §3. This was already true and is the largest cost by orders of magnitude.
- **Rendezvous** runs on a free tier via §4.6.
- **STUN** is free and public. Static config, no server.
- **TURN** is deferred (§9), and it is the only thing that would have required one.

Deleted as a result: `server.js`, `src/lib/server/`, `docker-compose.yml`, coturn, `/api/rooms`, `/api/ice`, and the `ws` dependency.

**The site is static** (`adapter-static`) and deploys to Cloudflare Pages or GitHub Pages for free. Total fixed cost: zero.

*Consequence:* room codes are generated client-side from `crypto.getRandomValues()` with no server to check collisions. At 34^6 ≈ 1.5 billion codes this is a non-issue, and it is checked anyway at join time: a host who finds the room already occupied regenerates. This is strictly better than the current build, which generates client-side and never checks at all.

Occupancy detection is **best-effort by design and stays that way**: the probe
observes the incumbent host's announce, and trystero announces at 233/533/1333ms
before settling into a 5.3s interval, so the window (`OCCUPANCY_PROBE_MS`,
1500ms) is sized to outlive the last warm-up burst plus relay latency and no
further. Waiting past the bursts buys nothing except a slower room open against
a collision space where collisions effectively do not happen.

### 4.8 Platform support: hosts are desktop, guests are anything

A clean product line that matches physical reality and mirrors the Plex server/client split.

**Hosting** requires reading a multi-gigabyte local file and possibly running two concurrent hardware encodes for hours. That is a desktop job. Doing it on a phone is thermal throttling and a dead battery, and phones do not have a real filesystem to point at anyway.

**Guesting** is decode and render, which every modern device does in hardware. iOS is a first-class guest via `ManagedMediaSource`, which Shaka already handles.

**Feature-detect, never UA-sniff.** Every capability claim in this document is a claim about a browser version at time of writing and will rot. Gate on `VideoEncoder.isConfigSupported()`, on `MediaSource.isTypeSupported()`, on the presence of `ManagedMediaSource`. Detected capabilities are surfaced in the probe so the failure message can be specific.

### 4.9 Stack

1. **Svelte 5 with runes.** The room component is rewritten from zero regardless. Migrating later means writing it twice.
2. **`adapter-static`.** No server exists (§4.7).
3. **Raw `RTCPeerConnection`** with the W3C perfect-negotiation pattern, over trystero's rendezvous.
4. **Host is the sole authority** for playback state and the sole source of truth for media bytes. Guests send intent, never commands, and never state to each other.

## 5. Dependency changes

**Remove:** `peerjs`, `peer`, `mongodb`, `@sveltejs/adapter-cloudflare-workers`, `@sveltejs/adapter-node`

**Add:** `trystero` (rendezvous), `shaka-player` (playback, ABR), `mp4box` (probe, demux, segmentation), `@sveltejs/adapter-static`, `mp4-muxer` (Phase 4), `@playwright/test` (dev)

**Keep:** `short-unique-id` for client-side room code generation, seeded from `crypto.getRandomValues()`.

Shaka is roughly 400KB gzipped. That is a good trade for not owning an MSE buffer manager.

## 6. Target file layout

As built (originally a target; reconciled to the tree after Phase 6):

```
src/
  lib/
    rendezvous/
      transport.ts       SignalingTransport interface (§4.6 escape hatch)
      trystero.ts        strategy ladder implementation
      codes.ts           client-side room code generation
      room.ts            hostRoomChecked retry policy, occupancy window
    rtc/
      connection.ts      RTCPeerConnection setup, perfect negotiation
      channel.ts         framing, chunking, backpressure, uplink shaping
      ice.ts             STUN config (static)
    media/
      probe.ts           tier classification (direct / transcode / reject)
      source.ts          host: mp4box segmentation from File (rep 0)
      manifest.ts        host: MPD generation
      ladder.ts          host: WebCodecs transcode rungs (Phase 4)
      origin.ts          the host origin: source + ladder + manifest as one
      types.ts           probe/ladder/segment-index types, LADDER config
      worker/
        encode.worker.ts transcode worker (Phase 4)
      shaka/
        scheme.ts        syncstream:// NetworkingEngine plugin
        config.ts        Shaka tuning, rung restrictions
    mesh/
      mesh.ts            Phase 5: guest-to-guest SegmentFetcher + tracker
    sync/
      clock.ts           NTP-style offset estimation
      state.ts           authoritative playback state
    room/
      host.ts            host engine: rendezvous, origin, roster, barrier
      guest.ts           guest engine: playback, sync, mesh, terminal states
    protocol/
      control.ts         JSON message types, control channel
      wire.ts            binary frame header, data channel
    barrier.ts           Phase 3 readiness barrier bookkeeping
    film.ts              now-playing title state
    identity.ts          remembered display name
    invite.ts            share-link construction (base-path aware)
    names.ts             default name generation
    stats.svelte.ts      the Phase 0 oracle: stats rune + window.__syncstream
    BarrierNotice.svelte CopyLink.svelte DebugOverlay.svelte
    FilePicker.svelte    HostBar.svelte InvitePanel.svelte NameTag.svelte
    NowPlaying.svelte    PausedNotice.svelte PlayerControls.svelte
    Presence.svelte      WaitingRoom.svelte     (Phase 6, see §12)
  routes/
    +page.svelte         landing
    room/[id]/
      +page.svelte       the room: player, picker, waiting room, people
tests/
  fixtures/gen.sh        committed small fixtures + gitignored large ones
  e2e/                   one spec per subsystem; scale/mesh/real-movie gated
                         on gitignored fixtures
```

`source.ts` and `origin.ts` are both live: source segments the file for
rep 0, origin composes source + ladder + manifest into the one object the
host serves from.

No `server.js`. No `src/lib/server/`. No `docker-compose.yml`. That is the point.

## 7. Phases

Each phase has a single acceptance criterion that is mechanically checkable. A phase is not done until its criterion passes, verified by driving the real app, not by reading the code.

---

### Phase 0: Reproduce and instrument

Nothing is fixed before the failure is observed end to end, the way a user meets it.

**Work**
- Get the current build running locally against a real multi-GB file.
- `tests/fixtures/gen.sh` generating, via ffmpeg:
  - `tiny-60s.mp4` (H.264/AAC, faststart, 1080p, ~5MB, committed)
  - `moov-at-end.mp4` (non-faststart, exercises the tail-read path, committed)
  - `ac3-audio.mp4` (**the §4.4 case**, committed)
  - `no-audio.mp4`, `vfr.mp4`, `surround-5.1.mp4`, `hevc.mp4` (committed, small)
  - `large-2gb.mp4` (generated on demand, gitignored)
- Reproduce with `large-2gb.mp4`: record time-to-first-frame, peak RSS on both sides, and whether it completes at all. Write the numbers into §11.
- Build the stats overlay that survives into the product behind a `?debug` flag: throughput, buffer depth, RTT, clock offset, drift, current rung, segment queue, **ICE connection state and selected candidate type**. It also exposes `window.__syncstream` as the test oracle.

The candidate type is not decoration. It is the measurement that decides §9: every `relay` candidate is a connection that would have needed TURN, and every `host`/`srflx` candidate is one that did not. Collect it from day one so the TURN question gets answered with data instead of a guess.

**Acceptance:** the failure is documented with real measured numbers, and the overlay reports live stats from the existing build.

---

### Phase 1: Foundation reset

The clean slate, without deleting the repo.

**Delete**
- `src/routes/room/[id]/+page.svelte` (rewritten from zero, not refactored)
- `src/lib/protocol.ts`
- `src/lib/mongo.ts`
- `src/routes/room/[id]/+page.server.ts` (no server)
- the dependencies listed in §5

**Migrate**
- Svelte 4 to Svelte 5 (`npx sv migrate svelte-5`), then hand-fix anything the codemod leaves.
- `adapter-static`. Verify the whole app builds and serves as static files.

**Build**

*Spike first, before anything else:* confirm `trystero`'s `room.getPeers()` returns a usable raw `RTCPeerConnection` that we can call `createDataChannel()` on. **The entire §4.6 approach depends on this.** If it does not, stop and take the fallback in §10 rather than routing media through trystero's own data-channel API.

*Rendezvous* (`src/lib/rendezvous/`): the `SignalingTransport` interface, and the trystero strategy ladder from §4.6. Host announces on all strategies; guest tries the link's strategy then falls through. Room creation blocks until at least one strategy confirms connection, so the code is never shown for a room that does not exist. Client-side code generation with join-time occupancy check.

*Transport* (`src/lib/rtc/connection.ts`, `channel.ts`): take the `RTCPeerConnection` from trystero, using the perfect-negotiation pattern (polite/impolite peer) so glare resolves without deadlock. Host creates two channels:

- `control`: ordered, reliable, JSON
- `data`: ordered, reliable, binary, negotiated id 1

Framing on `data`. SCTP preserves message boundaries, so no length prefix is needed, just a header per message:

```
[u8  msgType]
[u32 requestId]
[u32 chunkIndex]
[u32 totalChunks]
[payload]
```

Chunk size 64KB. Chrome tolerates 256KB but 64KB is the interop-safe number and paces better.

**Backpressure is the thing that was missing.** Before every send: if `dc.bufferedAmount > 1MB`, await the `bufferedamountlow` event with `bufferedAmountLowThreshold = 256KB`. Without this, the sender queues the entire file into the SCTP buffer as fast as the loop runs and the tab dies. This is the direct cause of the current OOM, and it is why §4.6 forbids using any wrapper's data channel API.

*Room lifecycle*: the room exists while the host is connected. Guests joining and leaving are non-events. Host departure ends it. This closes the current griefing hole where any guest can call `delete-room` on a 5s connect timeout or on disconnect and destroy the room for everyone.

**Acceptance:** a transport conformance test transfers a 1GB blob host-to-guest through the chunk protocol with peak RSS under 300MB on both sides, at a throughput within 20% of iperf on the same link. Rendezvous succeeds with the primary strategy disabled, proving the ladder. The whole app is served from `file://` or a dumb static server with no backend process running, proving §4.7. The app has no video in this phase; that is expected. This transport layer is not throwaway, it is what Phase 2 moves segments over.

---

### Phase 2: Streaming core

**Probe** (`src/lib/media/probe.ts`)

Runs on file select, before anything else. Parses the moov, enumerates tracks and codecs, checks each against `MediaSource.isTypeSupported()` and `VideoEncoder.isConfigSupported()`, and classifies the file into a §4.3 tier. Its output drives both the UI message and the source pipeline. Every rejection message names the actual reason ("audio is AC-3, which browsers cannot decode") rather than a generic failure.

**Host origin** (`src/lib/media/source.ts`)

Feed mp4box.js byte ranges from `File.slice()`, never the whole file. Loop: append a range, read `nextParsePosition` from the return, seek there, repeat until `onReady(info)` fires.

Handle both moov layouts. Web-optimized files have moov at the front and parse immediately. Plenty of real files have moov at the end, so when the head does not yield a ready state, read the tail (start with the last 2MB and grow) before giving up. This is the single most common real-world file shape we must not choke on.

Segmentation: `setSegmentOptions(trackId, user, { nbSamples })` then `initializeSegmentation()` for init segments, and `onSegment(id, user, buffer, sampleNum)` for media segments. Target ~4s per segment, with `nbSamples` derived from fps, **aligned to sync samples** from the `stss` random-access-point table. This is the CMAF alignment requirement from §4.1: non-keyframe-aligned boundaries break seeking and make rung switching impossible.

Cache produced segments in an LRU capped at 200MB keyed by `(repId, track, segIdx)`, regenerating from disk on miss.

**Manifest** (`src/lib/media/manifest.ts`): generate a DASH MPD from the parsed track info and segment index, with a `SegmentTemplate` over `syncstream://` URIs. One `AdaptationSet` for video with a `Representation` per available rung, one for audio with a single representation.

**Guest playback** (`src/lib/media/shaka/`)

Shaka Player, configured. `registerScheme('syncstream', handler)` where the handler parses `syncstream://rep/{r}/{track}/seg/{i}`, issues a `segReq` on the control channel, awaits the framed response on the data channel, and resolves with the ArrayBuffer. Wire Shaka's abort signal through to a `segCancel` so a seek does not leave orphaned requests in flight.

We write a URI parser and a promise. We do not write a player.

**Protocol** (`src/lib/protocol/control.ts`)

```
host -> guest:   ready { mpd }
guest -> host:   segReq { reqId, repId, track, segIdx }
host -> guest:   segData    (data channel, reqId in the frame header)
host -> guest:   segErr { reqId, reason }
guest -> host:   segCancel { reqId }
```

**Acceptance:** with `large-2gb.mp4`, time-to-first-frame under 5s, seek to an arbitrary timestamp resolves under 2s, peak RSS under 500MB on both sides, and playback runs to completion on a LAN with zero stalls. `moov-at-end.mp4` and `no-audio.mp4` play. `ac3-audio.mp4` and `hevc.mp4` are correctly classified as tier 2 and report that transcoding is not yet built, rather than failing silently or playing without sound.

---

### Phase 3: Sync engine

This is what makes it a watch party rather than two people counting down over Discord.

**Clock** (`src/lib/sync/clock.ts`): NTP-style offset estimation on the control channel. Guest sends `ping { t0 }`, host replies `pong { t0, t1 }`, guest receives at `t2`. Then `rtt = t2 - t0` and `offset = t1 - (t0 + t2) / 2`. Keep a sliding window of 16 samples and take the one with **minimum RTT**, which is the least queue-distorted estimate. Re-ping every 2s.

**State** (`src/lib/sync/state.ts`): the host broadcasts absolute intent, not relative toggles:

```
state { playing, mediaTime, atHostClock, seq }
```

on every change plus a 1s heartbeat. `seq` is monotonic; guests drop stale messages. The current build sends `video.paused ? 'play' : 'pause'` derived from whoever clicked, which is not idempotent and desyncs the moment two messages race.

**Guest correction loop**, every 250ms:

```
target = playing ? mediaTime + (hostNow - atHostClock) : mediaTime
err    = target - video.currentTime

|err| <  0.05s          rate = 1.0                              (deadband)
0.05s <= |err| < 0.5s   rate = 1 + clamp(err, -0.05, 0.05)      (inaudible nudge)
|err| >= 0.5s           hard seek                                (visible, but rare)
```

Set `playbackRate` on the media element Shaka is driving. Shaka's own trick-play rate handling is not involved.

**Guest intent**: guests send `intent { action: 'play' | 'pause' | 'seek', mediaTime }` to the host. The host decides and broadcasts. Guests never send to each other. This kills the current echo loop where the host rebroadcasts a guest's message back to its own sender.

**Readiness barrier**: guests report `status { bufferedAhead, rung, throughput }` every 1s, read straight off Shaka's own buffer and variant state rather than tracked by us. If any guest's `bufferedAhead` drops under 1s the host auto-pauses and surfaces "Waiting for Jamie". Resume when all guests are above 5s. User-toggleable. This is the feature that makes a slow guest visible instead of silently desynced, and it is what Phase 4 is protecting against.

**Acceptance:** two machines, 30 minutes of continuous playback with periodic play, pause, and seek, drift stays under 100ms at p99. A deliberate 3 Mbps throttle on one guest trips the barrier and the room recovers cleanly when it lifts.

---

### Phase 4: Adaptive bitrate and transcoding

The thing you actually asked for. It is Phase 4 because it is not expressible before Phase 2 and not tunable before Phase 3. It also retires the tier-2 stub from §4.3, so this phase is what makes the product work on real-world files rather than only well-formed ones.

**Ladder** (`src/lib/media/ladder.ts`, `worker/encode.worker.ts`)

Pipeline: mp4box demux to `EncodedVideoChunk`, into `VideoDecoder`, out as `VideoFrame`, into `VideoEncoder`, into `mp4-muxer` for CMAF segments. Audio takes the parallel `AudioDecoder` to `AudioEncoder` path to AAC per §4.4.

Rungs per §4.5. Rules that are not optional:

- **Every rung shares segment boundaries and timescale with rep 0.** This is the CMAF contract from §4.1 and it is why Phase 2 aligns to sync samples. Violating it glitches MSE on every switch.
- **Encode in a Worker**, concurrency capped at 1-2 to avoid hardware encoder contention.
- **Lazily, and only on demand**, prioritized by soonest-needed. Hardware encoders run well above realtime, so staying just ahead of the playhead is enough.
- **Serve a rung only once its leading segments are ready**, per the §4.2 wrinkle, so encode latency is never mistaken by Shaka's ABR for network congestion.
- **Graceful absence.** No WebCodecs means only rep 0 exists and ABR is a no-op. Tier-2 files are then honestly rejected on that device.

**ABR** is Shaka's, configured rather than written. Set `abr.defaultBandwidthEstimate` from the transport's own measurement so the first segment is not a guess, cap `abr.restrictions` where a rung is not yet generated, and leave the estimator alone. It already implements the conservative dual-EWMA logic and the switching hysteresis that we would otherwise write, and get subtly wrong, and maintain forever.

**Acceptance:** a guest throttled to 1.5 Mbps continues playing at 480p with zero stalls. Lift the throttle and it returns to native within ~15s. No visible glitch at the switch. The host's own playback stays smooth throughout, confirming worker isolation. `ac3-audio.mp4` plays with sound. A cold rung request does not trigger a spurious ABR downshift (the §4.2 wrinkle, tested explicitly).

---

### Phase 5: Scale past the host's uplink

The ceiling nobody notices until the demo. 1080p at ~8 Mbps times three guests is 24 Mbps of sustained upload, more than most home connections provide. **The host's uplink, not the code, is the binding constraint on room size**, and since §4.7 makes the host's uplink the only transport in the system, this is the one scaling limit that actually exists.

Because the protocol is already pull-based content-addressed segments, guests can serve each other:

- Guests announce `have { bitfield }` to the host, which acts as tracker.
- Guest asks `sources { repId, segIdx }`, host answers with peer ids holding it.
- Guest opens data channels directly to other peers. Rendezvous already brokers arbitrary pairs from Phase 1.
- Request policy: prefer the peer with the best measured throughput and fewest outstanding requests, fall back to the host. Order by proximity to the playhead, not rarest-first; playback is linear and rarest-first is a torrent optimization that does not apply.
- The host remains the authoritative source. Any segment is always fetchable from the host, so the mesh is an optimization that cannot cause a correctness failure.

This slots in below the Shaka scheme handler, which keeps asking for URIs and neither knows nor cares which peer answered.

**Acceptance:** four guests, host uplink shaped to 12 Mbps, all four sustain native quality. This is arithmetically impossible without the mesh, which makes it a clean test.

---

## 8. Testing

The instrumentation from Phase 0 is the oracle. `window.__syncstream` exposes the live stats object and the e2e tests assert against it.

- **Playwright**, one host context plus N guest contexts, Chromium first.
- **Throttling** per guest context via CDP `Network.emulateNetworkConditions`. This is how every network-dependent acceptance criterion above gets driven.
- **No sleeps.** Poll for conditions with explicit deadlines. A flaky sync test is worse than no sync test because it trains you to ignore it.
- **The fixture matrix runs against every phase.** It exists to catch exactly the class of bug §4.4 was, where a plausible assumption about real files was quietly wrong.
- **Rendezvous is tested with strategies disabled**, one at a time, since the ladder is the reliability argument for §4.6 and an untested fallback is not a fallback.

## 9. TURN: deferred, and measured before decided

**Decision: ship without TURN. Instrument the real failure rate. Revisit with data.**

TURN is the only thing in this design that would require infrastructure and the only cost that scales with usage, because it relays every byte. It is therefore the only thing standing between this plan and §4.7's zero.

The reason to defer rather than skip: **a host cannot run TURN.** A TURN server needs a public IP and a listening socket, and the host's browser is behind the very NAT that TURN exists to defeat. There is no version of this where the lobby host absorbs the cost without running a server, which defeats the purpose. So TURN is either infrastructure or it is absent, and absent is where we start.

What we lose: free public STUN handles ordinary residential NATs, which is most of them. Symmetric NAT is largely a carrier-grade-NAT and corporate-network problem, so the guests who fail will skew mobile. Published figures put the relay-required rate somewhere around 10-20%, but **that number is about generic WebRTC traffic and not about our population**, which is why we measure ours rather than borrow theirs.

Guests who cannot connect get an honest, specific message naming the cause, not a spinner.

**Revisit when Phase 0's candidate-type telemetry says so.** If the measured relay-required rate is low, this stays free forever. If it is high enough to matter, the options in order of preference:

1. **The §4.5 ladder is the cost governor.** Cap relayed peers to the 360p floor rung and a relayed 2-hour movie is about 360 MB, or roughly two cents at commodity TURN pricing, versus about 7.2 GB at native quality. A ~20x reduction that falls out of work already done.
2. **Host coturn where egress is flat-rate** (Hetzner, OVH). On metered cloud egress this is real money at scale; on a flat-rate box it is close to free.
3. **Phase 5's mesh helps, partially and not reliably.** A relayed guest can sometimes pull from a directly-reachable peer instead of from the host. But a peer that needs relay to reach the host frequently needs it to reach everyone, so this is a real mitigation and not a solution. Do not count on it.

If TURN is ever added, it comes with coturn's own `max-bps` / `user-quota` / `total-quota` rather than invented policy, ephemeral HMAC credentials, and **`denied-peer-ip` for all RFC1918 and link-local ranges**, because an open relay that reaches internal addresses is an SSRF pivot into your own network.

## 10. Risks

**`trystero.getPeers()` may not expose a usable raw `RTCPeerConnection`.** §4.6 depends on it entirely, which is why it is the first task in Phase 1 rather than a discovery in week three. If it does not, the fallback is to implement `SignalingTransport` directly against Supabase Realtime and Nostr, which is more code but is exactly the interface boundary §4.6 already requires. What we do **not** do is send media through trystero's data-channel API, because that reproduces the PeerJS bug with a new name.

**Free-tier rendezvous has a ceiling.** Supabase's free tier caps concurrent connections, and the anon key is public. Success or abuse can exhaust it. The strategy ladder is the mitigation and the Cloudflare Durable Object swap is the escape hatch, priced at about $5/month flat.

**Shaka's ABR estimator versus lazy rung generation** (§4.2). The main integration risk in the media path. Mitigated by pre-generation and by not advertising a rung until it is warm. Explicitly tested in Phase 4.

**mp4box segmentation of arbitrary user files.** Real MP4s in the wild are strange: broken indices, unusual codec configs, edit lists that shift timelines. §4.3 substantially defuses this, since anything unsegmentable falls to the transcode tier rather than to a dead end. What remains is the tier-2 rate being higher than expected, which costs host CPU rather than correctness. Phase 2's probe measures the real distribution against actual files.

**Host CPU during Phase 4.** Two concurrent encodes plus decode plus the host's own playback. Worker isolation and the concurrency cap are the mitigations; the acceptance criterion explicitly tests that host playback stays smooth.

**Retired by the §4 decisions:** MSE quirk handling, ABR oscillation, buffer eviction, seek-into-unbuffered, and codec switch glitches all move from "our bugs" to "Shaka's solved problems". iOS support moves from an accepted limitation to a supported guest platform. Server operations, deploys, room TTL sweeps, and multi-node HA move from "problems to solve" to "problems we do not have".

## 11. Results

Status: **built and verified**. Every number below is measured by driving the real app, not read off the code. Reproduce with `bun run test:e2e`.

### Phase 2 acceptance, at the stated scale

Against the real `large-2gb.mp4` (2.03 GB, 30 min, 1080p), host and guest as separate browser contexts (`tests/e2e/scale.spec.ts`):

| Measurement | Criterion | Measured |
| --- | --- | --- |
| Time to first frame | < 5s | **3.1s - 4.9s** |
| Seek to 900s | < 2s | **43 - 45ms** |
| Host JS heap | < 500MB | **104 - 123MB** |
| Guest JS heap | < 500MB | **37 - 38MB** |

The old build, for contrast, read the whole movie with `readAsArrayBuffer` and sent it as one message: first frame cost a complete transfer (~27 min for 4GB on a 20 Mbps uplink), repeated per guest, with both sides holding the file in JS heap. The inversion in §3 is what these numbers are.

Time to first frame is the one uncomfortable number. It passes, but the spread across runs reaches 4.9s against a 5s bar, so it is the first thing to watch if probe or segmentation cost grows, and the first thing to profile if the bar ever matters.

### Other criteria

- **§10's load-bearing risk is retired.** `trystero.getPeers()` returns a real `RTCPeerConnection` and `createDataChannel(..., {negotiated: true, id: 100})` succeeds on it. The §10 fallback was not needed.
- **Phase 1's ladder (§4.6)** works: a guest told to prefer MQTT reached a Nostr-primary host in 619ms. Rendezvous confirms in 464-558ms; a guest joins in ~730ms.
- **Phase 1's §4.7 claim is asserted, not trusted:** `tests/e2e/static.spec.ts` fails if a server entry point ever appears in `build/`, if the app makes any non-GET request to its own origin, or if the deleted dependencies come back.
- **Phase 3** holds: guest drift stays well inside the deadband, and a throttled guest trips the readiness barrier and the room recovers on its own when the throttle lifts.
- **Phase 4** works end to end: under a 1.5 Mbps cap a guest downshifts onto a rung the host encoded in-browser via WebCodecs and keeps playing; lifting the cap returns it to native.
- Bundle: strategy code is split out, keeping ~565KB of MQTT/Supabase payload out of the entry chunk. Total fixed cost remains zero.

### Three plan corrections the build forced

1. **§4.4 is too optimistic, and §4.8 is the tiebreaker.** The plan assumes AC-3/E-AC-3 audio can always be transcoded to AAC via `AudioDecoder`. Measured in Chromium 149: `MediaSource.isTypeSupported('audio/mp4; codecs="ac-3"')` is false *and* `AudioDecoder.isConfigSupported({codec: 'ac-3'})` is false. If no browser decodes it, WebCodecs cannot either, so it cannot be converted. `ac3-audio.mp4` is therefore an honest tier-3 reject naming the real cause, which still satisfies what §4.4 was written to prevent: silent video with no diagnostic. Feature-detected, never assumed.

2. **§8's throttling mechanism does not work.** The plan drives every network-dependent criterion with CDP `Network.emulateNetworkConditions`. It does not touch WebRTC: measured 246 Mbps unshaped versus 233 Mbps through a channel "capped" at 1.5 Mbps. CDP shapes the HTTP stack, not SCTP over UDP. The tests shape our own send path instead (`window.__syncstream.throttle`), which is closer to the thing being modelled anyway, since §5's binding constraint is the host's uplink and that is exactly the number being set.

3. **§4.6's strategy list has drifted.** trystero 0.25 split its strategies into separate packages; `trystero/supabase` and `trystero/mqtt` are now stubs that throw on import. The real imports are `trystero` (Nostr), `@trystero-p2p/mqtt`, and `@trystero-p2p/supabase`. Supabase also needs an account, so it is opt-in via `PUBLIC_SUPABASE_URL`/`PUBLIC_SUPABASE_ANON_KEY` and the ladder skips it when unset; Nostr and MQTT need no account and no quota, so they are the zero-cost floor that is always there. The §4.6 priority order is preserved for whenever credentials arrive.

### Deployment (added after the rebuild)

The rebuild left the app runnable but not reachable: every share link pointed at `localhost`, which is nobody else's machine. §4.7's "static files, no server" is what makes fixing that free -- pushing to `main` publishes to <https://mio-mahoney.github.io/SyncStream/> via GitHub Actions, on infrastructure that costs nothing and runs no process of ours. HTTPS comes with it, which is not a nicety: WebCodecs requires a secure context, so the §4.5 transcode tier does not exist over plain HTTP.

Two things fell out of doing it:

- **The share link was built by hand and ignored `paths.base`.** A Pages project site is served under `/<repo>/`, so `${origin}/room/${code}` produced a link that 404s -- correct on localhost and broken in the one place it is used. It now goes through `resolve()`, and the e2e suite runs under a non-empty base path by default, because a root-domain test run is the single configuration that cannot catch this.
- **§9's TURN decision is unchanged, but is now a config flip rather than a code change.** `PUBLIC_TURN_URLS`/`PUBLIC_TURN_USERNAME`/`PUBLIC_TURN_CREDENTIAL` mirror the Supabase opt-in: absent by default, so the cost that scales with usage stays absent. What §9 asks for -- measure, then decide -- is what the `?debug` overlay's candidate type is for.

### Known gaps, closed by the finishing pass (FINISH-PLAN.md)

Each of the three gaps this section used to list is now either measured shut or
retired by construction:

- **Phase 5's mesh is measured -- and its criterion, run for the first time,
  does not hold.** `tests/e2e/mesh.spec.ts` runs the §7 setup as written (four
  guests against `large-2gb.mp4`, host uplink shaped to 12 Mbps by the app's
  own shaper -- correction 2 below), observing the peer path through
  `stats.mesh`, wired through the guest status tick for exactly this. What the
  telemetry shows: the mesh protocol is correct and moves tens of MB
  guest-to-guest during the startup buffer fill, with zero fallbacks -- then
  goes silent. Phase 3's sync keeps every playhead aligned and every buffer
  equally full, so all four guests want the same segment within the same
  instant, and the announce coalesce (≤1s) plus a tracker round trip means no
  guest's cache is ever a useful answer for another's next fetch. Each
  estimator then reads only its ~3 Mbps share of the host uplink, no guest
  selects the 9.5 Mbps native rung, no native segment ever enters the mesh,
  and the room settles into a self-reinforcing 720p equilibrium: zero stalls,
  full buffers, criterion unmet. The suite records both truths:
  a passing test locks in what holds (12 Mbps carries four guests with zero
  stalls, mesh bytes flow, no fallbacks, the ladder stays contiguous), and
  the criterion itself runs as an expected-failure that will flip loudly the
  day Phase 5 grows the fetch diversity (staggered lookahead, or a leader
  pulling native for the room) that escaping the equilibrium needs. That
  design work is open, and it is the one substantive engineering gap this
  finishing pass leaves.
- **The Shaka `restrictions` wrinkle was live, not latent, and is retired by
  construction.** It was the throttled-ladder flake: the ladder warmed
  cheapest-first, so every intermediate advertised set had 720p as a hole in
  the middle, and the numeric window cannot express a hole, so guests
  downshifted onto the one cold rung (~2 of 3 runs, signature
  `rung 1, availableRungs [0,2,3]`). The ladder now warms and advertises
  top-down, so every advertised set is a contiguous prefix of the ladder --
  the only shape the window states exactly -- and a rung that fails to warm
  ends the ladder rather than reopening the hole below it. The invariant is
  asserted per run in `media.spec.ts`; the window in `shaka/config.ts` remains
  as defensive translation, not as the guarantee.
- **Sparse-keyframe files are rejected honestly, in the probe, naming the
  measured gap.** The probe computes the widest sync-sample gap from the moov
  it already parses (pure table arithmetic, no payload reads) and rejects past
  30s. Routing them to the transcode tier -- this section's old suggestion --
  would not have worked: every representation shares rep 0's segment grid (the
  CMAF contract that makes rung switching work), so encoded rungs inherit the
  same giant segments and the transcoder would burn CPU to reproduce the
  problem. Calibration checked against real content: a real BluRay x265 film
  measures a 10.6s max gap, well clear of the threshold, and
  `real-movie.spec.ts` (gated on a gitignored local film, like the scale
  specs) asserts a genuine movie is never rejected.

### Permanent limitations (by design; not TODOs)

- **Occupancy detection is best-effort** (§4.7): the probe window covers
  trystero's announce bursts and no more, because past them the wait buys only
  a slower room open against 1.5 billion codes.
- **Shaka's `restrictions` window cannot express a hole.** Guarded by the
  ladder's contiguity invariant above; would only return as a bug if someone
  reintroduces out-of-order advertisement.
- **No "you're hosting, leaving ends the party" prompt.** trystero's core
  tears down every room when the `beforeunload` *event fires*, not when the
  page actually unloads, so cancelling a confirm prompt strands a zombie room
  (host on a live page, guests already gone) -- measured in the Phase 6 run
  and confirmed in the package source. Suppressing its listener and re-driving
  teardown on `pagehide` would depend on module-load order and a private
  teardown path, for a prompt browsers may skip anyway. Guests are covered
  instead: the host link dropping gives every guest the terminal
  room-over screen within seconds.
- **CI runs without the gitignored fixtures** (`large-2gb.mp4`,
  `real-movie.mp4`) and therefore does not exercise Phase 2/4/5 at scale.
  Machines that have them run the gated specs; CI skips them visibly.

## 12. Phase 6: Usability (added after the rebuild)

The rebuild left an engine wearing a prototype. A second effort -- 29
iterations, run after Phases 0-5 and merged to `main` -- built the room around
it: the components in §6 from `WaitingRoom` to `PausedNotice`, six e2e specs
(`film`, `invite`, `join`, `naming`, `pause`, `picker`, `waiting`), and the
states a real watch party actually passes through. This section exists so the
document describes the product that ships, not the one that existed the day
the engine worked.

What it added, by area:

- **A waiting room with phases.** `searching / opening / found / rejected /
  room-over` each get a screen, with the roster of who else is waiting
  rendered for guests, not only for the host.
- **An invite panel and host bar.** The share link survives a base-path deploy
  (§11 Deployment), the picker reports rejections inside itself rather than in
  a page-top banner 700px away, and "Change video" lets a second film
  supersede the first without ending the room.
- **People with names.** A remembered identity, a `rename` wire message, and
  one name tag at every site the room reports its people. The host was
  previously the literal string "Host" and guests were "Guest 412".
- **Reader-addressed notices.** The readiness barrier and the paused notice
  render on the film as overlays (visible in fullscreen, where the one account
  of a stalled film used to be a black rectangle), and they name who -- except
  to that person, who instead gets nothing or their own phrasing.
- **Terminal states get a screen, not a banner.** A guest whose host left, or
  whose file was rejected, lands on a page that says so and offers a way out;
  fullscreen is exited for them, because `display:none` does not do it.

The invariants the iterations kept converging on, recorded so future copy
does not relearn them:

1. **A fact that depends on its reader ships per-link, not broadcast.**
   `waiting`, `paused`, and `roster` all carry per-recipient fields; a message
   written for one role must never render for another.
2. **The narration lives on the thing it narrates.** Rejections in the picker,
   stall notices on the film, presence next to the people -- never in a
   page-top status channel (the one that existed was deleted in iteration 20).
3. **Layout survives 1280x720.** The room chrome caps itself to the window and
   shrinks the film rather than pushing controls under the fold; fullscreen
   hides its control bar instead of burning 52px of it into the picture.
