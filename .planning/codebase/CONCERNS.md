# Codebase Concerns

**Analysis Date:** 2026-07-28

## Tech Debt

**Mesh equilibrium in synchronized playback:**
- Issue: Phase 5's guest-to-guest segment distribution never activates in steady state when guests are perfectly synced by Phase 3's clock engine. All four guests want the same segment in the same instant, so the tracker never has a useful answer for any peer, and each guest reads only its proportional share of the host uplink (e.g., 3 Mbps of 12 Mbps when split four ways). The room self-reinforces a 720p equilibrium with zero stalls but never selects native quality, so the mesh bytes flow only during startup buffer fill.
- Files: `src/lib/mesh/mesh.ts`, `tests/e2e/mesh.spec.ts`
- Impact: Phase 5's architecture works but does not achieve its scaling goal without additional fetch diversity (staggered lookahead, or a leader pulling native ahead of the group). This is recorded as an intentional engineering gap in FINISH-PLAN.md §11; the test locks in what holds and flags the limitation via expected-failure.
- Fix approach: Out of scope for current work, but documented. Requires either staggered request timing or a peer designated to pull higher-quality segments ahead of group playback to seed the mesh with higher-bitrate content.

## Known Bugs

**Public relay rendezvous flake (out of scope, noticed):**
- Symptoms: Occasionally a guest never reaches the host inside a spec's timeout when using public Nostr/MQTT relays.
- Files: `tests/e2e/rendezvous.spec.ts`
- Trigger: Unmodified `main` (2026-07-21, commit 543d00c) exhibits this. Appears to be transient relay weather, not a product bug.
- Workaround: The test suite alone walks the public ladder with spec-scoped `retries: 2` for this reason. Local e2e runs pin rooms to localhost via `?s=local` to avoid it during active development.
- Status: Recorded in FINISH-PLAN.md outcomes as "noticed, left alone".

## Security Considerations

**Public TURN credential exposure in static bundle:**
- Risk: User-provided TURN credentials are baked into the static-asset bundle and readable by any client. An attacker can use them to relay traffic through the configured TURN server.
- Files: `README.md`, `PLAN.md §9`, `src/lib/rtc/ice.ts`
- Current mitigation: Documentation (README.md) explicitly warns: "point them at something quota'd with short-lived credentials -- never a flat-rate relay you would mind strangers using." Credentials are environment variables, so they are not committed to git.
- Recommendations: Always use ephemeral HMAC credentials if TURN is configured. TURN is disabled by default, and credentials are opt-in via `PUBLIC_TURN_URLS`, `PUBLIC_TURN_USERNAME`, `PUBLIC_TURN_CREDENTIAL`. If a deployment uses TURN, apply coturn's `denied-peer-ip` to block RFC1918 and link-local ranges, preventing SSRF into internal networks (documented in PLAN.md §9).

**Supabase anonymous key in static bundle:**
- Risk: `PUBLIC_SUPABASE_ANON_KEY` ships in the bundle and is readable by any client. If Supabase Realtime policies are misconfigured, a stranger with the key could enumerate or hijack rooms.
- Files: `src/lib/rendezvous/trystero.ts`, `PLAN.md §4.6`
- Current mitigation: Documentation (PLAN.md §4.6) states: "Realtime channel policies must be scoped so a stranger with the key cannot enumerate or hijack rooms." This is a configuration responsibility on the deployer, not a code fix.
- Recommendations: If deploying with Supabase, verify Realtime policies restrict channel access to intended participants only. Test with a public anon key and verify rooms are not discoverable or hijackable by anyone with the key.

**No authorization on room lifecycle:**
- Risk: Any guest that joins a room can theoretically send control messages if the protocol validation is incomplete. The host is the sole authority, so this is mitigated by design, but protocol bugs could bypass it.
- Files: `src/lib/room/host.ts`, `src/lib/protocol/control.ts`
- Current mitigation: The protocol enforces that only the host broadcasts playback state and only guests send intent. The host doesn't execute guest commands, only guest intent (play/pause/seek), and re-validates everything before acting.
- Recommendations: Continue strict validation of incoming control messages. If the protocol expands to allow guest-to-guest messaging, verify authorization rules are explicit per message type.

## Performance Bottlenecks

**Time-to-first-frame near acceptance ceiling:**
- Problem: Against `large-2gb.mp4` (2.03 GB, 30 min, 1080p), TTFF measured 3.1-4.9s against a 5s criterion bar. The spread reaches the limit.
- Files: `src/lib/media/probe.ts`, `src/lib/media/source.ts`, `tests/e2e/scale.spec.ts`
- Cause: TTFF depends on file parse latency (probe moov scan, source segmentation for rep 0) plus the first segment encode-if-needed and first segment delivery. Probe's moov hunt could be slower on files with moov at the tail and very large sample tables.
- Improvement path: The 4.9s measurement is acceptable against the bar. Watch this on any changes to probe or segmentation that increase parse time. If TTFF creeps closer to 5s, profile the probe path and consider early-exit optimizations (e.g., stop reading tail windows once moov is found, not after all windows are exhausted).

**Shaka ABR estimator on tiny buffered fixtures:**
- Problem: On very small fully-buffered fixtures (Gigabytes of content buffered before playback), Shaka's ABR estimator sees all segments arriving instantly and estimates zero throughput, parking the guest below native quality even on a fast link.
- Files: `tests/e2e/media.spec.ts`
- Cause: The estimator is designed for live or streaming scenarios where segments arrive at playback rate. Instant buffering of everything is not a realistic scenario.
- Impact: This is unobservable on real-length content (the mesh test runs against `large-2gb.mp4` and does not encounter it). No action needed.

**Encode concurrency ceiling:**
- Problem: The ladder bounds concurrent WebCodecs encodes to 1-2 to avoid hardware encoder contention. If a file is heavily re-encoded (e.g., all four rungs needed immediately), the worst case is encoding all rungs serially.
- Files: `src/lib/media/ladder.ts`, `src/lib/media/worker/encode.worker.ts`
- Impact: Mitigated by lazy generation (rungs only generated on demand) and prioritization by soonest-needed. On a modern machine with 2+ hardware encoders available, this is acceptable.
- Improvement path: If a deployment shows users waiting for rung availability, measure actual hardware encoder capacity and increase the ceiling if available.

## Fragile Areas

**Sparse-keyframe file handling:**
- Files: `src/lib/media/probe.ts`, `src/lib/media/source.ts`
- Why fragile: Files with very large sync-sample gaps (>30s) cause `source.ts` to produce single enormous segments. These cannot be split without re-encoding.
- Safe modification: The probe now computes the max RAP-to-RAP gap from the moov (pure table arithmetic) and rejects files past 30s, routing them to the transcode tier if WebCodecs is available. The rejection is honest (names the measured gap). Any change to segmentation logic must preserve CMAF alignment (segment boundaries must be identical across all rungs) or MSE rung switching will glitch.
- Test coverage: `tests/e2e/media.spec.ts` asserts sparse-keyframe.mp4 is classified and rejected correctly. A real BluRay x265 film measures 10.6s max gap (no misfire).

**Lazy rung generation and Shaka ABR interaction:**
- Files: `src/lib/media/ladder.ts`, `src/lib/media/shaka/scheme.ts`, `src/lib/media/shaka/config.ts`
- Why fragile: When a guest's ABR downshifts onto a rung that is not yet encoded, the network handler stalls while the worker encodes. Shaka's throughput estimator reads this stall as low throughput and may downshift further.
- Safe modification: The mitigation is documented in PLAN.md §4.2: "serve a rung only once its leading segments are ready." The ladder must warm rungs top-down (highest quality first) and must not advertise a rung to the manifest until its first N segments are cached and ready. The config in `shaka/config.ts` caps restrictions to contiguous prefixes so holes never appear. Any change to advertising logic (when a rung becomes available) must maintain this invariant.
- Test coverage: `tests/e2e/media.spec.ts` explicitly tests a throttled guest on the ladder; the mesh test runs the 4-guest 12 Mbps scenario. Any regression here will show as spurious downshifts under load.

**Negotiated RTCDataChannel framing:**
- Files: `src/lib/rtc/channel.ts`, `src/lib/rtc/connection.ts`
- Why fragile: Negotiated data channels (not created with `pc.createDataChannel(...)` at call time) are created eagerly and may open before the remote has called `createDataChannel` yet. Bytes sent into that gap are silently discarded. This caused the "hello never landed" race in earlier iterations.
- Safe modification: The protocol now sends hello on first connection and answers with hello-answer on receipt, so both directions cannot fall in the gap. The invariant is: never assume a message will be received on first send; all load-bearing messages must have either an ack/answer or a retry loop. The hello-answer handshake is the example.
- Test coverage: `tests/e2e/room.spec.ts` ("link the host copies") and the full suite exercise this. Changes to channel initialization must preserve the hello/hello-answer exchange.

**Occupancy check false negatives:**
- Files: `src/lib/rendezvous/room.ts`, `PLAN.md §4.7`
- Why fragile: The occupancy probe window (1500ms) covers trystero's announce bursts (233/533/1333ms) plus relay latency. If a rival host's hello is delayed past this window, two hosts can claim the same code simultaneously.
- Safe modification: This is intentional and best-effort by design (PLAN.md §4.7). The window is sized to cover the announce bursts; extending it indefinitely trades user-visible latency for a non-problem (collisions are negligible at 34^6 codes). Any change to the window or announce strategy must preserve the best-effort character and document the tradeoff. The fallback is per-guest occupancy detection at join time (if the room is already occupied, the guest rejects it).

## Scaling Limits

**Host uplink is the binding constraint:**
- Current capacity: ~12 Mbps demonstrated with four guests at native quality (1080p ~8 Mbps each); typical home uplink is 5-20 Mbps.
- Limit: Where it breaks is when total guest bitrate (sum of all rungs selected) exceeds the host's uplink capacity. The host cannot serve guests faster than it uploads.
- Scaling path: Phase 5's mesh is the solution. It lets guests serve each other. However, as noted in Mesh equilibrium above, the current implementation achieves load-shedding but not quality improvement without additional fetch diversity.

**Free-tier rendezvous concurrency:**
- Current capacity: Supabase Realtime free tier (if configured) has per-project concurrency limits; Nostr and MQTT public relays have no per-user quota.
- Limit: Supabase's free tier can be exhausted by success or abuse of the public anon key.
- Scaling path: Fall through the strategy ladder (PLAN.md §4.6) to Nostr or MQTT. Cloudflare Durable Objects (one per room, ~$5/month flat) is the documented escape hatch (§4.6 debt containment). The ladder itself is not a cost and is always available; Supabase is just one strategy.

**Client-side room code collision:**
- Current capacity: 34^6 ≈ 1.5 billion codes; collision probability at realistic usage levels is negligible.
- Limit: Client-side collision detection works but is best-effort (occupancy probe window). A rival host's hello can be delayed past the window.
- Scaling path: Not needed at current scale. If room codes become a collision problem, upgrade to UUIDs and pre-check occupancy via a lightweight DHT or per-deployment directory server. This would require infrastructure, contradicting the zero-backend design, so it is deferred indefinitely or to a different product phase.

## Dependencies at Risk

**shaka-player 5.2.1:**
- Risk: Shaka is a large and complex library (400 KB gzipped). It is the direct owner of the MSE buffer, variant switching, and ABR. Any MSE bug in Shaka cascades into the playback experience.
- Impact: High. The entire Phase 2/3 media path depends on Shaka's correctness.
- Mitigation: Shaka is Google's production player at YouTube scale. It is actively maintained and has over a decade of MSE quirk fixes. The risk is acceptable and the alternative (writing our own MSE buffer) is orders of magnitude larger.
- Migration plan: Keep Shaka updated on security releases. Monitor for issues in the Shaka repo. If a regression appears, the escape hatch is to fork Shaka locally and patch it, or to implement a simpler hardcoded MSE buffer for the specific subset of Shaka's features this app uses (buffer management, variant selection, seek). This is not a current concern.

**trystero 0.25.3:**
- Risk: trystero is the rendezvous layer and single point of dependency on Supabase/Nostr/MQTT. If trystero has a bug in any strategy, that strategy becomes unusable until trystero is updated.
- Impact: Medium. The strategy ladder means losing one strategy is survivable; losing all three simultaneously is unlikely.
- Mitigation: The SignalingTransport interface (§4.6 debt containment) makes the dependency reversible. If trystero becomes untenable, implementing direct Nostr/MQTT connectors behind the interface is the escape hatch.
- Migration plan: Monitor the @trystero-p2p org for issues and updates. Supabase Realtime support is opt-in via env vars, so it is safe to disable. Nostr and MQTT (via @trystero-p2p/mqtt) are the always-available floor.

**@trystero-p2p/core, @trystero-p2p/mqtt:**
- Risk: The trystero ecosystem split into separate packages (trystero 0.25). Imports must use the new @trystero-p2p paths or they throw. This is fragile during dependency upgrades.
- Impact: Low. The import statements are explicit and well-documented in `src/lib/rendezvous/trystero.ts`.
- Mitigation: The code comment at the top of trystero.ts documents the package split. Update the imports immediately if upgrading trystero.

**mp4box 2.4.1:**
- Risk: mp4box is a JavaScript MP4 parser and the direct owner of demux and segmentation logic. Any parser bug on a malformed file could corrupt segments or crash the probe.
- Impact: Medium. User-provided files can be arbitrarily malformed. The three-tier probe (direct/transcode/reject) mitigates by classifying honestly rather than assuming.
- Mitigation: The probe includes a `MAX_APPENDS` safety limit to prevent infinite loops on corrupt files. Any file that does not yield a moov within 64 reads is rejected.
- Migration plan: mp4box is mature and widely used. If a regression appears, the fallback is to use FFmpeg as an external service to demux and segment (defeating the zero-backend design). Do not go there unless necessary.

**mp4-muxer 5.2.2:**
- Risk: mp4-muxer is the Phase 4 encoder output library. It writes fMP4 bytes. A bug in fMP4 writing breaks every encoded rung.
- Impact: Medium (Phase 4 only; Phase 2 passthrough is unaffected).
- Mitigation: The output is tested against Shaka's parser. Any byte corruption shows up immediately as a playback failure.
- Migration plan: Monitor the mp4-muxer repo. If issues arise, the fallback is to use FFmpeg to encode instead of WebCodecs (again, infrastructure cost).

## Missing Critical Features

**Host-leaves-silently prompt (permanent limitation):**
- Problem: A host closing the tab ends the party with no warning. A `beforeunload` prompt would help, but trystero tears down rooms on the `beforeunload` event itself, so cancelling the prompt yields a zombie room (guests gone, host still live).
- Blocks: User experience feels broken when a host leaves unaware.
- Impact: Guests detect host-gone via link drop and get a terminal room-over screen within seconds. This is detected (not prevented), which is better than silent desync but still not ideal.
- Workaround documented in PLAN.md §11 permanent limitations: "No 'you're hosting, leaving ends the party' prompt." The decision was made during FINISH-PLAN.md execution (2026-07-21). Do not re-open without redesigning the trystero integration.

## Test Coverage Gaps

**E2E test infrastructure fragility:**
- What's not tested: Tests depend on port availability (4173 for app, 4174 for local relay), machine sleep, and relay weather. All of these are documented but increase flake risk.
- Files: `tests/e2e/base.ts`, `playwright.config.ts`, `tests/e2e/local-relay.ts`
- Risk: A stale `vite preview` on 4173 causes tests to measure the wrong build. Laptop sleep mid-test produces spurious failures. Public relay flakes require retries.
- Priority: High (infrastructure, but manageable). The memory notes document these issues and workarounds.

**Public rendezvous strategy coverage:**
- What's not tested: CI does not exercise MQTT or Nostr signaling at scale (only the local relay strategy). A regression in a public strategy would only be caught by real cross-network runs.
- Files: `tests/e2e/rendezvous.spec.ts`
- Risk: Low to medium. The strategies are in vendor code (trystero), not ours. The test that does run has `retries: 2` for transient relay weather.
- Recommendation: Run the full suite including public-relay strategies periodically in a dedicated CI job, not every commit.

**Scale tests gate on gitignored fixtures:**
- What's not tested: CI skips `scale.spec.ts`, `mesh.spec.ts`, and `real-movie.spec.ts` because they require `large-2gb.mp4` and `real-movie.mp4`, which are gitignored.
- Files: `tests/e2e/scale.spec.ts`, `tests/e2e/mesh.spec.ts`, `tests/e2e/real-movie.spec.ts`
- Risk: Medium. Phase 2/4/5 acceptance criteria are only verified on machines that have the fixtures. A regression at scale could slip through CI.
- Recommendation: This is documented and intentional (the fixtures are too large to commit). Machines with the fixtures should run them regularly. CI should visibly skip these tests with a message (current behavior).

---

*Concerns audit: 2026-07-28*
