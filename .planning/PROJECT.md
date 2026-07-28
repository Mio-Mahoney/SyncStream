# SyncStream

## What This Is

A serverless watch-party app. The host opens a video file off their own disk and guests watch it together, in sync, over WebRTC. Nothing uploads, nothing transcodes in the cloud, and there is no backend: the site is static files on GitHub Pages and the host's own uplink is the only transport.

It is built for watching a film with a handful of people you know and invite by link.

## Core Value

The people you invite can actually watch the film with you, and when they can't, they are told why.

The engine already works. What it lacks is the second half of that sentence: every failure so far has been silent, which makes the product feel broken and makes it undebuggable.

## Requirements

### Validated

<!-- Shipped and confirmed working. Inferred from the codebase map and verified this session. -->

- ✓ Host serves a local file as CMAF segments without uploading it — `media/source.ts`, byte ranges via `File.slice()`
- ✓ Guests play via Shaka through a custom `syncstream://` scheme — `media/shaka/scheme.ts`
- ✓ Host-authoritative playback sync with NTP-style clock offset and a readiness barrier — `sync/clock.ts`, `sync/state.ts`
- ✓ Adaptive bitrate ladder encoded in-browser with WebCodecs, H.264 for every rung — `media/ladder.ts`
- ✓ Three-tier file probe that classifies honestly rather than guessing — `media/probe.ts`
- ✓ Peer rendezvous over a public relay ladder, no signaling server of ours — `rendezvous/`
- ✓ Guest-to-guest segment mesh with host always available as fallback — `mesh/mesh.ts`
- ✓ Static deploy to GitHub Pages on every push to main — `.github/workflows/deploy.yml`, live at `https://mio-mahoney.github.io/SyncStream/`
- ✓ Time-to-first-frame 3.1-4.9s and seek 43ms against a 2 GB file — `tests/e2e/scale.spec.ts`

### Active

- [ ] A guest that cannot decode the host's file says so, by name, instead of sitting in the lobby
- [ ] A guest that cannot decode rep 0 is served an H.264 rung it can play
- [ ] The e2e suite can express a guest whose codec support differs from the host's
- [ ] A user who hits any failure can report something useful without opening devtools
- [ ] The console is quiet when the app is healthy
- [ ] A connection that fails on NAT says so, and records whether a relay would have helped
- [ ] Dependency versions are pinned, so the live site cannot change without a commit

### Out of Scope

- **Operating a TURN server** — the only cost that scales with usage, and the host's browser cannot run one. Decided this milestone: make relay-needed failures honest and measure how often they happen, then revisit with data. See Key Decisions.
- **Mesh quality equilibrium** — a room of synced guests never climbs past 720p because everyone wants the same segment at the same instant. Real, documented in `CONCERNS.md`, and an optimization rather than a correctness bug. Deferred.
- **A "you're hosting, leaving ends the party" prompt** — trystero tears down rooms on `beforeunload`, so cancelling the prompt yields a zombie room. Permanent limitation, recorded in PLAN.md §11.
- **Accounts, chat, playlists, a library** — the product is one film with people you invited. Every one of these needs a backend.
- **Public-relay rendezvous hardening** — flake is transient relay weather in vendor code, not a product bug.

## Context

The engine is finished and deployed; this milestone is about the gap between "works on my machine" and "works for the person I sent the link to."

That gap has a concrete instance. A friend joined a room and never saw a frame. The console they sent contained two errors, and reproduction proved **both appear in healthy sessions** that reach first frame in 602ms:

- `blob:… ERR_METHOD_NOT_SUPPORTED` ×2 — Shaka HEAD-sniffing a blob URL that has no extension, then silently recovering via its GET fallback (`networking_utils.js:36-43`)
- a 404 on the room URL — the documented GitHub Pages SPA trick in `scripts/spa-fallback.js`

The real cause was structural. `probe.ts:440` decides playability with `MediaSource.isTypeSupported()` **in the host's browser**, and `Hello` carries only `{ role, name }` — the guest is never asked what it can decode. The file was HEVC Main 10; an Apple Silicon Mac reports it playable, so the host chose tier `direct` and served native HEVC. The guest was then pinned to `availableRungs: [0]`, the HEVC passthrough, and had no decodable variant.

The fix is cheap because the fallback already exists: `ladder.ts:634` encodes **every rung as H.264**, "the only codec with universally available hardware encode." The guest could have played rung 1. It was never offered one.

No test could have caught this. Every e2e spec runs the guest in the host's own `BrowserContext`, so both ends always have identical codec support. `real-movie.spec.ts` hosts this exact film and passes in 27 seconds.

## Constraints

- **Architecture**: No backend, ever. Static files only. Any fix that needs a server is the wrong fix.
- **Tech stack**: SvelteKit + adapter-static, Shaka Player, WebCodecs, trystero. Established and not up for revision this milestone.
- **Performance**: TTFF is measured at 3.1-4.9s against a 5s bar. Any change that adds work before first frame spends a budget that is already nearly exhausted.
- **CMAF invariant**: Every representation shares rep 0's segment grid. Rung switching breaks if segment boundaries diverge.
- **Warm-order invariant**: `shaka/config.ts` keeps ABR restrictions a contiguous prefix so no holes appear. Per-guest rung sets must not violate this — it is the hard part of the codec fix.
- **Audience**: Friends, invited by link. Not strangers arriving cold. Reliability for people you know beats onboarding polish.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Fix codec asymmetry by negotiation, not by always encoding an H.264 floor rung | A mandatory encode before `ready` would spend the entire TTFF budget protecting rooms that may be all-Mac | — Pending |
| Guest's "I can't decode this" message doubles as the capability signal | The honest-failure message and the negotiation input are the same message, so the two phases decompose naturally rather than being sequenced out of caution | — Pending |
| No TURN server this milestone; make relay-needed failure honest and measure it | `ice.ts` already records selected candidate type "so that rate is measured rather than guessed" — the instrument exists, the data just never leaves the browser. Decide with data, not vibes | — Pending |
| Per-guest `rungs` before per-guest manifests | `host.ts:266` already sends `rungs` per link, so per-guest variant control needs no new plumbing. Escalate to per-guest MPD only if the prefix invariant makes rung sets untenable | — Pending |
| Commit a lockfile | `deploy.yml` runs `bun install --frozen-lockfile` against a repo with no lockfile. Nothing pins the live site | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-07-28 after initialization*
