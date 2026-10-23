# SyncStream - status

What the app measures today, how, and what is known not to work. [PLAN.md](PLAN.md) is the design and its history, [REVIEW.md](REVIEW.md) the October 2026 review whose findings the current code works through. This file is the one to read for the current truth; when it and PLAN.md disagree, this is right.

Last measured: 2026-10-23, on one machine (Apple Silicon laptop, Chromium via Playwright, host and guest in separate browser contexts over loopback, rendezvous on the localhost relay). The machine was not idle: load averages of 6-10 during the runs, so the spread is wider than a quiet machine would show. Reproduce with `scripts/measure-scale.sh 10`.

## Phase 2 acceptance, as PLAN.md states it

Against `large-2gb.mp4` (2.2 GB, 30 min, 1080p H.264, direct tier), ten runs:

| Measurement                                  | Criterion | Measured (min / median / max)                           | How                                                                                                                |
| -------------------------------------------- | --------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Time to first frame                          | < 5 s     | **2000 / 3472 / 6786 ms**, over the bar in 2 of 10 runs | from the host's `ready` landing to the first frame _painted_ (`requestVideoFrameCallback`), at the host's position |
| Seek to 900 s                                | < 2 s     | **459 / 488 / 723 ms**                                  | from the seek control to a _landed_ seek: not seeking, a decodable frame, within 2 s of the target                 |
| Peak process memory, heavier side            | < 500 MB  | **404 / 432 / 577 MB**, over the bar in 1 of 10 runs    | renderer RSS from `ps`, pids from the browser over CDP, sampled every 500 ms; the heavier renderer is the host     |
| Host JS heap                                 | < 500 MB  | 130 / 150 / 176 MB                                      | `usedJSHeapSize`                                                                                                   |
| Guest JS heap                                | < 500 MB  | 28 / 79 / 83 MB                                         | `usedJSHeapSize`                                                                                                   |
| Stalls during 20 s of playback past the seek | 0         | 0 / 0 / 0                                               | `waiting` events outside a seek, counted in `stats.stalls`                                                         |

Every number above is from a different oracle than the one PLAN.md §11 originally quoted, and the differences are the point:

- **Seek** was 43-45 ms. That was the intent round trip plus the `currentTime` assignment, not a frame. A landed seek is around half a second over loopback.
- **Memory** was 104-123 MB of JS heap. The process was over the bar: before the encode worker had backpressure, a 4 s GOP of raw 1080p frames (~360 MB) sat in the encoder's queue per worker and the host renderer peaked at 515-640 MB in nine of ten runs. With backpressure the median is 432 MB and one run in ten still touched 577 MB. The heap number was never wrong; it was never the budget.
- **First frame** is measured on a painted frame at the host's position, which is later and more honest than `loadeddata` at position 0. It passes in eight runs of ten on a loaded machine and misses in two, and the budget is not nearly exhausted by anything on the host: probe and origin together take about 120 ms. The time is in the guest's player, and the fetch trace (`stats.fetchTrace`, printed by `scale.spec.ts`) shows what it is made of. Shaka's untested-link bandwidth estimate is 1 Mbps, so a guest's first pick is the lowest rung that is warm, and the bottom rung becomes selectable only once the host has encoded the opening segments of all three rungs (the warm set must stay a contiguous prefix, see `shaka/rungs.ts`). That takes about 3 s on this machine. Deferring the warm-up was tried and moved the first frame later by the same amount. The remaining lever is making the lowest rung warm first, which the window shape forbids, or giving Shaka a measured estimate before the first pick, which the room does not yet have.

## What was fixed in the October 2026 pass

Every finding in REVIEW.md §3 except the ones listed under "Still open" below. In one sentence each:

- The invite link carries a key; the code alone finds the room and connects to nobody (F-01).
- A guest at the end of the film does not deadlock the barrier (F-02, before the review's fixes).
- A peer cannot grow the host's memory with partial transfers; frames are admitted only for requests this side made and reassembly is capped per link (F-03).
- Segment keys are scoped to a film id, so changing the film cannot cross-feed old bytes or be swallowed by an identical manifest (F-04, F-05).
- A second file that cannot be built leaves the first playing and tells every screen why (F-06); fragmented MP4s are rejected in the probe with a remedy (F-07).
- A guest whose browser cannot play the film leaves the barrier and is named to the host with the cause (F-08).
- Negative composition offsets mark their `trun` version 1 (F-09); a guest without the native codec is windowed to the smallest playable rung before load (F-10).
- The host validates every request against the exact segment index, caps requests in flight per guest, and releases encode jobs on cancel or departure (F-11).
- The host's per-guest candidate type is refreshed (F-12); "unreachable" says what was observed and only an ICE failure counts as "needed TURN" (F-13); a room with people and no host says so (F-13).
- A buffering host no longer makes guests seek-loop (F-14); a pause is honoured mid-seek and a newer seek supersedes one in flight (F-15); lifecycle leaks are closed (F-16); rearm no longer re-pauses on stale evidence (F-17); one audio representation (F-18); names off the wire are validated (F-19); the player loads at the host's position (F-20); the README no longer documents Supabase (F-21).

And the tests measure what they claim (REVIEW §4): landed seeks, painted frames, process memory, a stall counter, a recovery that actually resumes, and the two fixtures nobody loaded.

## Still open

- **Phase 5's criterion** (four guests hold native over a 12 Mbps host uplink) is unmet, as PLAN.md §11 records in detail. `mesh.spec.ts` still carries a `test.fail()` for it. The host's uplink is not reduced by the mesh today.
- **Drift over 30 minutes on two machines** has never been measured. The suite asserts single samples under 0.5 s on one machine.
- **Codec asymmetry's first pick** is windowed, but the e2e spec does not assert which rung the first segment came from.
- **A host that closes mid-film** ends the party for guests within seconds; a prompt before leaving is not possible with the rendezvous library's teardown (PLAN.md §11, permanent limitations).
- **Hypotheses H-1 to H-11** in REVIEW.md have not been tested.
- **Safari and Firefox** are untested, as are real NATs, public-relay outages, background tabs and laptop sleep.

## How to read the numbers again

```bash
bun run test:unit                 # the pure modules, under a second
bun run test:e2e                  # the whole suite, ~25 minutes with the large fixture
scripts/measure-scale.sh 10       # the table above
```

`tests/e2e/scale.spec.ts` prints every quantity in the table and a fetch trace for the first frame on both sides, so a regression can be attributed from the test output alone.
