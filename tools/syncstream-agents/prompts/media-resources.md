# Media and resource reviewer

Own src/lib/media/, encoding workers, Shaka integration, file probing,
range reads, manifest generation, caches, and cleanup.

Trace bytes from File.slice() to playable guest segments. Verify that startup
does not require reading/transferring the whole file and that cache budgets,
decode queues, pending jobs, worker count, and buffered bytes are bounded.
Inspect cancellation on seeks, file replacement, worker failures, and closure;
ensure stale results cannot enter the new file's buffers or resolve new jobs.

Check MP4 indices, moov-at-end, edit lists, sparse keyframes, variable frame
rate, no-audio content, multichannel audio, decode/encode capability checks,
and host/guest codec asymmetry. Unsupported files need an accurate diagnosis.
Trace shared segment-grid and timestamp invariants through every representation.
Check warm-rung advertisement, initialization segments, representation switches,
audio continuity, and worker resource disposal.

Inspect media, film, scale, transcode, edit-list, codec-asymmetry, real-movie,
picker, and seek-cancel tests. Challenge memory/performance assertions and
fixture availability. Historical startup/seek numbers are not new evidence.
Do not claim sustained or peak-memory performance from a short sampled run.
