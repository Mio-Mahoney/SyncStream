# Synchronization and mesh reviewer

Own src/lib/sync/, barrier logic, src/lib/mesh/, and playback/ABR interactions
in the host and guest integration.

Trace host authority, state revision ordering, clock-offset estimation,
scheduled playback, readiness barriers, pauses, seeks, late joins, and slow
guest recovery. Check old pongs, delayed state, concurrent controls, background
tabs, autoplay rejection, participant churn, and long-session timer cleanup.

For mesh, inspect tracker freshness, request identity, cache availability,
striped ownership, prefetch policy, host fallback, peer disappearance, and
deadlines. Distinguish protocol correctness from useful sustained coverage.
Measure total host and guest traffic including wasted/duplicate prefetch,
selected quality, stalls, film advancement, and convergence time. A burst of
peer traffic at startup does not establish sustained uplink savings.

Inspect clock, pause, waiting, barrier-override, ABR-recovery, seek-cancel, mesh,
and scale tests. A criterion that all guests sustain native quality requires
simultaneous observation over a hold window while playback advances. Preserve
expected-failure visibility. State what needs shaped links, generated fixtures,
physical devices, or cross-network experiments.
