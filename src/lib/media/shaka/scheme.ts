/**
 * The `syncstream://` scheme plugin (PLAN.md 4.2, Phase 2).
 *
 * Shaka asks for a URI; we hand back bytes. Shaka does not learn that there is
 * no HTTP here, and in exchange we keep its buffer manager, seek logic, ABR and
 * browser quirk table. This file is a URI parser and a promise. It is not a
 * player, and nothing here may grow into one.
 *
 * The fetcher is module-global because `registerScheme` is itself global state
 * on NetworkingEngine. Mirroring that honestly beats pretending otherwise: a
 * guest has exactly one host, and a second registration replaces the first.
 */

import shaka from 'shaka-player/dist/shaka-player.compiled.js';
import { INIT_SEGMENT, type Track } from '$lib/protocol/control';

export const SCHEME = 'syncstream';

/**
 * Resolves segment bytes, or rejects. Implementations turn this into a `segReq`
 * on the control channel and await the framed reply on the data channel. The
 * signal fires when Shaka aborts (a seek away from an in-flight range), which
 * the caller turns into a `segCancel` so the host stops sending.
 *
 * **The fetcher must enforce its own deadline.** Settling is not optional: a
 * fetcher that neither resolves nor rejects hangs Shaka forever. Because we
 * register with progressSupport=false (see below), NetworkingEngine applies
 * *none* of `retryParameters.timeout`, `connectionTimeout` or `stallTimeout` to
 * this plugin -- verified against shaka-player 5.2.1, which skips those timers
 * entirely for schemes without progress support. So a `segReq` the host never
 * answers (dropped frame, host stalled encoding a cold rung, mesh peer vanished
 * mid-transfer) yields no timeout, no retry and no error: the guest's buffer
 * drains and playback stops permanently, and under the Phase 3 readiness
 * barrier that one unanswered request pauses the entire room indefinitely.
 * Rejecting on a deadline turns that into a RECOVERABLE error Shaka retries.
 */
export type SegmentFetcher = (
	repId: number,
	track: Track,
	segIdx: number,
	signal: AbortSignal
) => Promise<Uint8Array>;

/**
 * The one URI shape. The manifest's SegmentTemplate substitutes
 * `$RepresentationID$` and `$Number$` into exactly this, so any change here is
 * a change to manifest.ts and vice versa.
 */
export function segmentUri(repId: number, track: Track, segIdx: number): string {
	const tail = segIdx === INIT_SEGMENT ? 'init' : `seg/${segIdx}`;
	return `${SCHEME}://rep/${repId}/${track}/${tail}`;
}

// `rep` lands in the authority position, which keeps the URI absolute under
// Shaka's RFC 3986 resolution against the manifest URI. Nothing else relies on
// it. Digits only: $Number$ is never negative, and the init sentinel is spelled
// `init` rather than `seg/-1` so the URI stays readable in a network log.
const URI_RE = new RegExp(`^${SCHEME}://rep/(\\d+)/(video|audio)/(?:init|seg/(\\d+))$`);

export function parseSegmentUri(
	uri: string
): { repId: number; track: Track; segIdx: number } | null {
	const m = URI_RE.exec(uri);
	if (!m) return null;
	const repId = Number(m[1]);
	const segIdx = m[3] === undefined ? INIT_SEGMENT : Number(m[3]);
	if (!Number.isSafeInteger(repId) || !Number.isSafeInteger(segIdx)) return null;
	return { repId, track: m[2] as Track, segIdx };
}

let fetcher: SegmentFetcher | null = null;

function abortedError(): shaka.util.Error {
	return new shaka.util.Error(
		shaka.util.Error.Severity.CRITICAL,
		shaka.util.Error.Category.PLAYER,
		shaka.util.Error.Code.OPERATION_ABORTED
	);
}

/**
 * RECOVERABLE and NETWORK so Shaka's retry logic applies: a `segErr` is usually
 * a transient host-side miss, not a dead stream.
 */
function fetchError(uri: string, cause: unknown, requestType: number): shaka.util.Error {
	return new shaka.util.Error(
		shaka.util.Error.Severity.RECOVERABLE,
		shaka.util.Error.Category.NETWORK,
		shaka.util.Error.Code.HTTP_ERROR,
		uri,
		cause,
		requestType
	);
}

async function run(
	fetch: SegmentFetcher,
	parsed: { repId: number; track: Track; segIdx: number },
	uri: string,
	request: shaka.extern.Request,
	requestType: number,
	signal: AbortSignal
): Promise<shaka.extern.Response> {
	let bytes: Uint8Array;
	try {
		// Racing the signal makes Shaka's abort contract ours to honour rather
		// than every fetcher's: abort() must reject promptly with
		// OPERATION_ABORTED even if the fetcher is slow to unwind its own state.
		bytes = await Promise.race([
			fetch(parsed.repId, parsed.track, parsed.segIdx, signal),
			aborts(signal)
		]);
	} catch (e) {
		if (signal.aborted) throw abortedError();
		throw fetchError(uri, e, requestType);
	}
	if (signal.aborted) throw abortedError();
	return {
		uri,
		originalUri: uri,
		// Reassembled segments are frequently subarray views; toArrayBuffer only
		// copies when the view is partial.
		data: shaka.util.BufferUtils.toArrayBuffer(bytes),
		headers: {},
		originalRequest: request,
		fromCache: false
	};
}

function aborts(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		signal.addEventListener('abort', () => reject(abortedError()), { once: true });
	});
}

const plugin: shaka.extern.SchemePlugin = (uri, request, requestType) => {
	const parsed = parseSegmentUri(uri);
	if (!parsed) {
		return shaka.util.AbortableOperation.failed(
			new shaka.util.Error(
				shaka.util.Error.Severity.CRITICAL,
				shaka.util.Error.Category.NETWORK,
				shaka.util.Error.Code.UNSUPPORTED_SCHEME,
				uri
			)
		);
	}
	const fetch = fetcher;
	if (!fetch) {
		// Shaka outliving the transport is a teardown race, not a stream fault.
		return shaka.util.AbortableOperation.failed(abortedError());
	}
	const controller = new AbortController();
	return new shaka.util.AbortableOperation(
		run(fetch, parsed, uri, request, requestType, controller.signal),
		async () => controller.abort()
	);
};

export function registerSyncStreamScheme(fetch: SegmentFetcher): void {
	fetcher = fetch;
	// progressSupport stays false: we resolve whole segments rather than
	// streaming them, so NetworkingEngine's own end-to-end timing is the honest
	// throughput sample for the ABR estimator. The price is that Shaka arms no
	// request timers at all for this scheme, which is why SegmentFetcher above
	// makes the deadline the fetcher's contractual obligation. Flipping this to
	// true is not the fix: the connection timer is only cleared by a progress
	// event, so a plugin that resolves whole segments and never reports progress
	// would have every slow-but-healthy segment aborted at connectionTimeout.
	shaka.net.NetworkingEngine.registerScheme(SCHEME, plugin);
}

export function unregisterSyncStreamScheme(): void {
	fetcher = null;
	shaka.net.NetworkingEngine.unregisterScheme(SCHEME);
}
