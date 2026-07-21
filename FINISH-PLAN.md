# SyncStream: Finishing Plan

Status: **executed** (branch `finish/tracks-1-2-3`; see Outcomes at the end for
where reality disagreed with the plan). Companion to [PLAN.md](PLAN.md), which
describes the streaming rebuild (Phases 0-5, "built and verified"). This
document covers the work that was left to call the project _finished_, and the
reconciliation PLAN.md needed to stay a truthful map.

## Context: two efforts, one of them undocumented

The repo holds two implementation efforts:

1. **The streaming rebuild** (PLAN.md). Phases 0-5 are built and verified at
   scale against `large-2gb.mp4`. Real remaining gaps are enumerated in PLAN.md
   §11 "Known gaps".
2. **The usability layer** (the `my-project-is-still-089a95` run, 29 iterations,
   fully merged to `main`). It added ~15 Svelte components and 6 e2e specs and
   is effectively exhausted for the "clunky prototype" brief. **PLAN.md does not
   mention any of it** - §6's file layout and the "room page rewritten from
   zero" framing predate the entire UI. That staleness is Track 3.

Health at time of writing: `bun run check` clean (0 errors, 399 files); gnhf
branch merged; `work/plan-implementation` is a stale worktree at `main`'s commit
and should be pruned (`git worktree remove`).

Scope decision (confirmed): **Tracks 1, 2, 3. No further UX polish.**

---

## Track 1 - Close the engine correctness gaps

### 1.1 Sparse-keyframe files (the one user-facing correctness gap)

**Problem.** `source.ts` cuts video only at sync samples (`planByRap`,
`source.ts:227`). A file with one GOP over a long span produces a single
enormous segment; the LRU even has a comment for it (`source.ts:151`). Today the
probe neither rejects nor warns, and the ladder does not re-key - PLAN.md §11
records this as unhandled. The result on such a file is a broken-feeling stream
(one giant fetch, no seek granularity) with no diagnostic.

**Decision to make first:** reject-in-probe vs. re-key-in-ladder.

- _Reject-in-probe_ is small and honest, and it matches §4.3's tier model: if
  the largest RAP-to-RAP span exceeds a threshold (e.g. > 30s or > N MB), the
  probe classifies the video track `transcode` (re-key needed), falling to
  `reject` where WebCodecs is absent - exactly the existing tier ladder.
- _Re-key-in-ladder_ is the "correct" long answer (Phase 4 already owns a
  transcoder) but larger, and rep 0 passthrough still can't be re-keyed without
  becoming a transcode.

**Recommendation:** detect in the probe, route to the existing `transcode` tier,
and let Phase 4's encoder produce keyframe-dense rungs. Where WebCodecs is
absent, `reject` with a message naming the real cause ("this file has very
sparse keyframes and needs re-encoding to stream"). This reuses machinery that
exists rather than adding a fourth code path.

**Work.**

- Compute max RAP gap while planning segments (data is already in `stss` /
  `is_sync`, read in `source.ts`), thread it into the probe's per-track result.
- Add the classification branch in `probe.ts` (`classifyTrack`, ~line 503).
- Fixture: add `sparse-keyframe.mp4` to `tests/fixtures/gen.sh` (ffmpeg
  `-g <large>` / `-keyint_min`), commit it small.
- Test in `media.spec.ts`: the fixture is classified honestly and its message
  names the cause, mirroring the existing `ac3-audio`/`hevc` tier assertions.

**Acceptance:** `sparse-keyframe.mp4` is classified `transcode` (or `reject`
without WebCodecs) with a cause-naming message; no single-segment passthrough
stream is ever produced silently.

### 1.2 Prove the Phase 5 mesh

**Problem.** `mesh/mesh.ts` is implemented but has no test. PLAN.md §11 and §7
Phase 5 both flag the 4-guest / 12 Mbps acceptance criterion as never run. The
"cannot cause a correctness failure by design" guarantee is unmeasured.

**Work.**

- New `tests/e2e/mesh.spec.ts`: one host + 4 guest contexts, host uplink shaped
  via `window.__syncstream.throttle` (per §11 correction 2, CDP does not shape
  SCTP - the app's own throttle is the real knob), assert all four sustain the
  native rung with zero stalls, and assert via the debug oracle that at least
  one segment was served guest-to-guest (not host-sourced).
- This needs `large-2gb.mp4` or a fixture big enough that the host uplink is the
  binding constraint; gate the test on the fixture like `scale.spec.ts` does.

**Acceptance:** the §7 Phase 5 criterion runs green, and the mesh's
peer-to-peer path is observed, not assumed.

### 1.3 Document the Shaka non-contiguous-restrictions limit

**Problem.** `shaka/config.ts:89` already documents that Shaka's numeric
`restrictions` window can't express a warm rung set with a hole in it.

**Work.** Confirm 1.2 doesn't surface it as a live bug; if it stays latent,
promote the code comment to PLAN.md §11's permanent-limitations list (Track 3)
and add a targeted unit assertion that a hole clamps conservatively (never
advertises an un-warm rung). No engine change unless 1.2 proves it bites.

---

## Track 2 - Reliability and flakes

### 2.1 The ABR announce/downshift race (a real desync, not just a flaky test)

**Problem.** `media.spec.ts`'s throttled-ladder test fails ~2 of 3 baseline runs
with `Expected value: 1, Received array: [0, 2, 3]`. Diagnosis from the run
notes: the guest's Shaka downshifts onto a lazily-generated rung _before_ the
`rungs` control message that announces it is applied to `stats.availableRungs`
(`guest.ts:354-357`). So the manifest/ABR sees a rung the guest's own
availability state does not - a window where playback and advertised capability
disagree.

**Work.**

- Make rung availability monotonic from the guest's view: a rung must be in
  `stats.availableRungs` (and its restriction lifted) _before_ Shaka can select
  it. Options: apply the `rungs` update synchronously ahead of any variant
  change, or have the host withhold a rung from the MPD/announce until its
  leading segments are warm (§4.2 already says "serve a rung only once its first
  segments are ready" - verify the announce honors that ordering end to end).
- Re-test with the repeated-sampling standard the notes established (byte-for-
  byte signature + N isolated runs), and a stashed baseline to confirm the race
  is actually closed rather than re-hidden by timing.

**Acceptance:** the ladder test passes on 5+ isolated runs where baseline failed
~2/3; the guest never reports playing a rung absent from its own availability.

### 2.2 `picker.spec.ts:160` frame-count flake

**Problem.** The test guards on `frames.length > 3` (rAF samples), which is
scheduler luck, not a product fact - fails ~3/8. Iteration 27 flagged it.

**Work.** Replace the frame-count threshold with a frame-count-independent
oracle (assert the picker's busy state was the _only_ narration of the read,
sampled by state transition rather than by how many rAF ticks landed).

**Acceptance:** the test asserts the product invariant and stops flaking on
scheduler timing.

### 2.3 Occupancy-check window

**Problem.** `OCCUPANCY_PROBE_MS=1200` is sometimes too short for a rival host's
`hello` to arrive, so two hosts can claim one code (iteration 11). PLAN.md §4.7
calls collision detection best-effort by design.

**Work.** This is a genuine trade (longer probe = slower room open). Two honest
options, pick one: (a) accept and document it as a permanent best-effort
property in PLAN.md §4.7 (cheap, matches the "1.5 billion codes" argument), or
(b) lengthen/adaptively-extend the probe only until the first rendezvous
strategy confirms a peer set, bounding the cost. **Recommendation: (a) document
it** - the collision probability is negligible and (b) trades user-visible
latency against a non-problem. Flag for the user's call.

### 2.4 Host-leaves-silently (design spike, then decide)

**Problem.** A host closing/reloading the tab ends the party with no warning.
Iteration 23 proved a `beforeunload` prompt is _unshippable_ as-is: trystero
runs its own room-leave callbacks on the `beforeunload` event itself, so
cancelling the prompt yields a zombie room (guests gone, host still on a live
page). The fix is a listener-ordering fight (register on `window` before
trystero, `stopImmediatePropagation`), which also suppresses the _legitimate_
leave.

**Work (spike, timeboxed).** Determine whether we can register our leave-guard
ahead of trystero and re-drive trystero's teardown _only_ on a confirmed unload
(not on the cancellable event). If yes: a real "you're hosting - leave and the
party ends?" prompt. If no: leave it out and document why, rather than shipping a
guard that lies. **Deliverable is a decision with evidence, not necessarily a
feature.**

---

## Track 3 - Reconcile PLAN.md with reality

PLAN.md must stop describing a product that no longer exists.

**Work.**

- Add **§ "Phase 6: Usability"** (or an appendix) summarizing the 29-iteration
  UI layer: waiting room phases, invite panel / host bar, barrier & paused
  notices, naming/identity, now-playing, responsive layout, and the copy/role
  invariants the iterations established (per-link messages for reader-dependent
  facts; "a message written for one role must not reach another"; terminal
  states get a screen, not a banner).
- Update **§6 file layout** to match `src/` as built (`mesh/`, `room/host.ts` +
  `room/guest.ts`, `identity.ts`, `film.ts`, `barrier.ts`, `invite.ts`,
  `names.ts`, and every component). Note `media/origin.ts` vs `media/source.ts`
  and confirm which is live.
- Move the now-resolved §11 gaps (the ones Track 1/2 closes) into results;
  demote the truly permanent ones (occupancy best-effort, Shaka
  non-contiguous restrictions if 1.3 confirms) to a "Permanent limitations"
  list so they're not mistaken for TODOs.
- Add the two §11 corrections from experience that aren't yet in the doc body if
  any remain (CDP-can't-shape-SCTP, trystero package split - both already in
  §11, verify).

**Acceptance:** a new engineer reading PLAN.md + FINISH-PLAN.md can predict the
`src/` tree and the product's behavior without surprises.

---

## Sequencing

Correctness → reliability → docs, but Track 3's file-layout reconciliation can
land first (cheap, no risk) so the map is right while Tracks 1-2 change it.

1. **Track 3 file-layout pass** (fast, unblocks orientation).
2. **1.1 sparse-keyframe** (only user-facing correctness gap).
3. **2.1 ABR race** (real desync; also de-flakes CI).
4. **1.2 mesh proof** + **2.2 picker flake** (test-heavy, parallelizable).
5. **2.4 host-leaves spike** + **2.3 occupancy decision** (both end in a
   documented decision).
6. **Track 3 narrative pass** (fold results back into PLAN.md).

## Verification

- Every task's acceptance is checked by driving the real app (per the repo's
  standing rule), not by reading code.
- Flake claims use the notes' repeated-sampling standard: a stashed baseline
  measured over N runs, byte-for-byte failure signature, not a single pass.
- Scale/mesh tests gate on `large-2gb.mp4`; document that CI without the fixture
  does not exercise Phase 2/4/5 at scale (an existing, unchanged limitation).

## Open decisions for the user

- **1.1:** reject-in-probe (recommended) vs. re-key-in-ladder.
- **2.3:** document occupancy as best-effort (recommended) vs. lengthen probe.
- **2.4:** ship a host-leave prompt only if the spike clears the trystero
  ordering constraint; otherwise document and skip.

---

## Outcomes (2026-07-21, branch `finish/tracks-1-2-3`)

Executed in full. Where reality disagreed with the plan above, reality is
recorded here and the plan text left as written.

- **2.1 - fixed, but the diagnosis above was wrong.** Not an announce/downshift
  race: the `rungs` message applied fine. It was the `shaka/config.ts`
  limitation live: cheapest-first warming plus ever-present rep 0 meant every
  intermediate advertised set had 720p as a hole, and Shaka's numeric window
  cannot express a hole, so the cold rung stayed selectable all warm-up.
  Baseline 4/6 failures (3x the `[0,2,3]` signature, 1x an unpolled
  precondition); fixed by warming top-down so advertised sets are contiguous
  prefixes; 6/6 green after. **This settles 1.3 too**: the limitation was
  live, not latent, and is now unreachable by construction.
- **1.1 - done, as reject-always rather than route-to-transcode.** The
  recommendation above missed that every representation shares rep 0's
  segment grid, so the transcode tier would inherit the same giant segments.
  The probe computes the max sync-sample gap from the moov (pure table
  arithmetic) and rejects past 30s naming the measured gap. Threshold checked
  against a real BluRay x265 film: 10.6s max gap, no misfire.
- **1.2 - done.** `mesh.spec.ts` runs the Phase 5 criterion as written; mesh
  accounting wired into `stats.mesh` so the guest-to-guest path is observed.
  Plus `real-movie.spec.ts`: a gitignored local-film slot proving the pipeline
  on genuine content (HEVC 1080p BluRay rip: classified honestly, plays).
- **2.2 - was already fixed** on `main` before this plan was written
  (`4d5477e` replaced the frame-count threshold with the state-transition
  oracle). Struck.
- **2.3 - fixed by arithmetic, not by either option above.** The 1200ms window
  contradicted its own justification: trystero's warm-up announces at
  233/533/1333ms, so 1200 closed 133ms before the third burst. Now 1500ms
  (covers every burst plus latency), and best-effort-by-design is documented
  in PLAN.md §4.7. Option (b)'s adaptive extension remains rejected.
- **2.4 - decision: no prompt, documented.** trystero core tears down rooms on
  the `beforeunload` event itself (confirmed in `@trystero-p2p/core`
  `room.mjs`, not just from iteration 23's measurement), so a cancellable
  prompt strands a zombie room, and the workaround depends on module-load
  order plus a private teardown path. Guests already get the terminal
  room-over screen via host-gone detection. Recorded in PLAN.md §11
  permanent limitations.
- **Track 3 - done.** PLAN.md: header status corrected (it still said
  "proposed, not started"), §6 layout reconciled to the tree, §4.7 occupancy
  reality, §11 gaps moved to closed-with-measurements plus a permanent
  limitations list, and §12 (Phase 6: Usability) recording the 29-iteration
  UI layer and its invariants.

Out of scope, noticed, left alone: the public-relay rendezvous flake (a
guest occasionally never reaches the host inside a spec's timeout; reproduced
on unmodified `main`), and Shaka parking a fast guest below native on tiny
fully-buffered fixtures (estimator starvation, already documented in
`media.spec.ts`; unobservable on real-length content).
