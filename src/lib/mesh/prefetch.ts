/**
 * Fetch diversity (PLAN.md 11's equilibrium escape): the prefetcher.
 *
 * A purely reactive mesh fails the Phase 5 criterion structurally: Phase 3
 * keeps every guest's playhead and buffer aligned, so all of them want segment
 * N in the same instant, the announce coalesce plus a tracker round trip means
 * nobody's cache is ever a useful answer for anybody else, every guest splits
 * the host uplink evenly, and every estimator reads a fraction that never
 * selects native - the measured, self-reinforcing 720p equilibrium. The escape
 * is to make the caches diverge on purpose: the host deals each guest a stripe
 * (`meshPlan`), and each guest walks a window ahead of its own live fetches,
 * pulling only the segments it owns - the playing rung first (that dedupe is
 * what frees the host's uplink: each segment now leaves the host once, not
 * once per guest), then rep 0 (that is what breaks the equilibrium: native
 * bytes enter the mesh without waiting for any guest's ABR to select native),
 * then audio. By the time the room's aligned live fetches arrive, the owner
 * has held and announced the segment for several seconds, so the tracker
 * finally has an answer and the aligned demand lands on peers. Shaka is not
 * steered anywhere (4.2 stands: no AbrManager, restrictions untouched) - its
 * estimator simply starts measuring peer-served fetches instead of a quarter
 * of the host, and upshifts by itself. Prefetch goes out only while our own
 * live demand is quiet (PREFETCH_QUIET_MS), so it spends idle link time rather
 * than competing with the segment the viewer is waiting for, and every
 * prefetch rides the ordinary fetch path - peer first, host always - so the
 * mesh's invariant is untouched: a wrong, stale or missing plan costs duplicate
 * host fetches, never a segment.
 */

import { NATIVE_REP, SEGMENT_TARGET_SEC } from '$lib/media/types';
import { segKey, type Track } from '$lib/protocol/control';
import { MESH_CACHE_KEYS } from '$lib/mesh/cache';

/**
 * How far past our own live fetch edge the prefetcher starts, in segments.
 *
 * The gap is what hides the announce and tracker latency, and its floor is set
 * by the ask cadence: a consumer's last tracker ask for a segment lands up to
 * EMPTY_SOURCE_TTL_MS before its fetch, so the owner must have finished and
 * announced (ANNOUNCE_MIN_MS) before then, or the consumer fetches from the
 * host with the bytes sitting one hop away. Three segments is ~12s at the 4s
 * target: ~5s of hard floor, the rest slack for the prefetch's own download
 * time under contention.
 */
export const PREFETCH_MARGIN = 3;

/**
 * Window depth in segments. Bounded so a stalled playhead stops the prefetcher
 * rather than letting it walk the whole film, and sized against the CACHE'S
 * LIFETIME, not just its bytes: at native bitrates the LRU holds roughly 40s
 * of combined live-plus-prefetch inflow, so a window much deeper than that has
 * its early pulls evicted before the room consumes them -- bytes the host paid
 * to send twice, and stale tracker claims (a consumer's sources entry lives
 * SOURCE_TTL_MS) that end in PeerMiss. Eight segments is ~32s of media,
 * comfortably inside the span.
 */
export const PREFETCH_DEPTH = 8;

/**
 * Quiet time on our own live demand before a prefetch may go out.
 *
 * THIS IS THE GOVERNOR, and what it replaced is worth stating because the
 * replacement looked right for weeks. The gate used to be "prefetch while our
 * buffer is at least 10s deep", on the theory that a deep buffer means spare
 * capacity. It does not, and measurement showed the gate never closed once:
 * Shaka's bufferingGoal is 30s, so every guest that is not actively drowning
 * sits at 26-33s buffered forever -- including a guest pinned to the bottom
 * rung, which has a full buffer and no spare bandwidth whatsoever. Buffer
 * depth measures how far ahead we have read, not what the link can still
 * afford. With the gate stuck open, prefetch ran flat out and took 49% of
 * every byte the room pulled, on the one resource the phase exists to
 * conserve.
 *
 * Outstanding live demand is the honest signal, because it is the contention
 * itself rather than a proxy for it: while Shaka is waiting on a segment, a
 * prefetch issued now shares the host's token bucket with it and slows the
 * thing the viewer is actually waiting for. So prefetch waits for our own
 * demand to go quiet, which is exactly the "background scavenger of headroom"
 * this was always documented to be. The delay is short because the gaps are:
 * a caught-up guest fetches roughly one segment per segment-duration, so
 * anything under a second reads as "between segments in a burst" rather than
 * idle. Re-armed by the guest's 1s status tick (`tick`), so no timer here.
 */
export const PREFETCH_QUIET_MS = 500;

/**
 * A key the prefetcher has already attempted -- delivered, failed, or since
 * evicted -- is not attempted again for this long. Attempts, not failures:
 * `cache.has` cannot be the only dedupe, because the LRU may evict a
 * speculative segment before it is consumed, and a prefetcher that re-pulls
 * whatever eviction uncovers turns the cache budget into a permanent refetch
 * loop against the host (measured: it emptied every cache faster than guests
 * could use them and zeroed the mesh entirely). An evicted speculation is a
 * loss the live path absorbs, not a debt to repay. Longer than a window's
 * transit past the edge (PREFETCH_DEPTH segments at the 4s target), so a key
 * ages out of the window before it ages out of this memory.
 */
const PREFETCH_TRIED_TTL_MS = 120_000;

export type PrefetchTarget = { repId: number; track: Track; segIdx: number };

export type PrefetcherOptions = {
	/** Whether a key is already held, so the window skips it. */
	has(key: string): boolean;
	/** The ordinary fetch path: peer first, host always. */
	fetch(repId: number, track: Track, segIdx: number, signal: AbortSignal): Promise<Uint8Array>;
	onPrefetched(bytes: number): void;
};

export class Prefetcher {
	readonly #opts: PrefetcherOptions;
	#plan: { slot: number; of: number; rungs: number[] } | null = null;
	/** The segIdx of the most recent LIVE video fetch, i.e. where Shaka is. */
	#liveEdge = -1;
	/** The rung those live fetches are asking for. */
	#liveRep: number | null = null;
	/** Whether this film has audio at all, learned from the traffic itself. */
	#sawAudio = false;
	/**
	 * Live segment requests Shaka is waiting on right now, and when the last one
	 * settled. Together these are "is the viewer waiting on this link", which is
	 * what the prefetch gate asks (see PREFETCH_QUIET_MS).
	 */
	#liveInFlight = 0;
	#lastLiveSettledAt = Number.NEGATIVE_INFINITY;
	#maxSegIdx = Number.POSITIVE_INFINITY;
	#busy = false;
	#closed = false;
	readonly #abort = new AbortController();
	/** key -> when it was attempted. See PREFETCH_TRIED_TTL_MS for why attempts. */
	readonly #tried = new Map<string, number>();
	/**
	 * The prefetch currently in flight, so a live fetch for the same key rides
	 * it instead of starting a second full download. Under the criterion's
	 * contended uplink a native segment trickles for tens of seconds, and the
	 * playhead can reach it mid-transfer; without this the owner then pays for
	 * the same megabytes twice, on the one link that has none to spare.
	 */
	readonly #inFlight = new Map<string, Promise<Uint8Array>>();
	#prefetched = 0;

	constructor(opts: PrefetcherOptions) {
		this.#opts = opts;
	}

	/** Bytes pulled ahead of need so far. */
	get prefetched(): number {
		return this.#prefetched;
	}

	/** A download already under way for `key`, to ride instead of racing. */
	inFlight(key: string): Promise<Uint8Array> | undefined {
		return this.#inFlight.get(key);
	}

	/**
	 * The host's `meshPlan`, off the wire via guest.ts, so typed but unchecked.
	 * A nonsense plan is a plan to ignore, and no plan means the reactive mesh,
	 * which works.
	 */
	setPlan(slot: number, of: number, rungs: number[]): void {
		if (this.#closed) return;
		if (!Number.isInteger(slot) || !Number.isInteger(of) || of < 1 || slot < 0 || slot >= of)
			return;
		if (!Array.isArray(rungs)) return;
		const cleaned = [...new Set(rungs.filter((r) => Number.isInteger(r) && r >= 0))].sort(
			(a, b) => a - b
		);
		this.#plan = { slot, of, rungs: cleaned };
		this.kick();
	}

	/** The film's length, so the window stops at the last segment. */
	noteDuration(durationSec: number): void {
		if (!Number.isFinite(durationSec) || durationSec <= 0) return;
		// The same soft bound ladder.ts derives: the last index a target-length
		// grid can hold. The real grid is cut at sync samples and may end a
		// segment or so early; the failure memory absorbs the overshoot.
		this.#maxSegIdx = Math.max(0, Math.ceil(durationSec / SEGMENT_TARGET_SEC) - 1);
	}

	/**
	 * Shaka asked for a segment. Only Shaka's own requests move the edge - the
	 * prefetcher's speculative reads would otherwise have the window chase
	 * itself down the film. Assignment, not max: a seek is a new edge in either
	 * direction, and a window stranded ahead of a backward seek prefetches a
	 * part of the film the room just left.
	 */
	noteLive(repId: number, track: Track, segIdx: number): void {
		if (track === 'video') {
			this.#liveEdge = segIdx;
			this.#liveRep = repId;
		} else {
			this.#sawAudio = true;
		}
	}

	/**
	 * Counted around the whole live fetch, init segments included: an init
	 * segment gates playback start, so it is the demand least worth competing
	 * with. This counts DEMAND, not transfers -- a request answered from our own
	 * cache settles immediately and re-opens the gate at once, which is correct,
	 * because it never touched the link.
	 */
	liveStarted(): void {
		this.#liveInFlight++;
	}

	liveSettled(): void {
		this.#liveInFlight--;
		this.#lastLiveSettledAt = performance.now();
		// The gate cannot open here (the quiet window has only just started),
		// but the edge may have moved, and `kick` from the status tick will look
		// again shortly.
	}

	/**
	 * Whether the link is ours to spend right now: nothing of Shaka's is
	 * outstanding, and nothing has been for PREFETCH_QUIET_MS. See that constant
	 * for why this replaced a buffer-depth check.
	 */
	#linkIsIdle(): boolean {
		if (this.#liveInFlight > 0) return false;
		return performance.now() - this.#lastLiveSettledAt >= PREFETCH_QUIET_MS;
	}

	/**
	 * The next owned, missing segment in the window: rung-major, nearest-first
	 * within each rung.
	 *
	 * Scan order is the priority scheme, and it is rung-major on purpose: the
	 * whole window at every rung the ROOM is playing (cheapest first, and
	 * audio, which is nearly free) before the first speculative native byte.
	 * Deduping what the room is fetching NOW is what frees the host's uplink,
	 * and the freed uplink is what pays for the native seeding that follows --
	 * so under scarcity every spent byte goes to the dedupe that unlocks more
	 * bytes, and native waits. The interleaved order (all rungs per segment,
	 * nearest first) read better on paper and lost to arithmetic: a ~5MB
	 * native segment through a contended uplink blocks the next cheap dedupe
	 * pull behind ~20s of trickle, and the dedupe never takes hold.
	 *
	 * The rung list is the ROOM's (`meshPlan.rungs`), not just our own,
	 * because a split room starves on the difference: an owner covering only
	 * its own rung leaves its stripes cold at every rung it is not playing,
	 * the guests below fetch those from the host in aligned lockstep, and
	 * Shaka's duration-weighted estimator reads only that slow residue -- the
	 * measured way a guest parks at 480p while its neighbour holds native.
	 */
	next(): PrefetchTarget | null {
		const plan = this.#plan;
		if (!plan || this.#liveEdge < 0) return null;
		// Alone in the room there is nobody to serve and nothing to dedupe: a
		// solo guest already has the host's whole uplink, and speculative pulls
		// would only churn the cache against segments no one will ever ask for.
		if (plan.of < 2) return null;
		// Cheapest video rungs first (higher id = lower bitrate), our own rung
		// merged in against the plan's ~1s of lag, audio next, rep 0 last.
		const videoRungs = new Set(plan.rungs);
		if (this.#liveRep !== null) videoRungs.add(this.#liveRep);
		videoRungs.delete(NATIVE_REP);
		const reps: { repId: number; track: Track }[] = [...videoRungs]
			.sort((a, b) => b - a)
			.map((repId) => ({ repId, track: 'video' as const }));
		if (this.#sawAudio) reps.push({ repId: NATIVE_REP, track: 'audio' });
		reps.push({ repId: NATIVE_REP, track: 'video' });

		const now = performance.now();
		const start = this.#liveEdge + PREFETCH_MARGIN;
		for (const rep of reps) {
			for (let i = 0; i < PREFETCH_DEPTH; i++) {
				const segIdx = start + i;
				if (segIdx > this.#maxSegIdx) break;
				if (segIdx % plan.of !== plan.slot) continue;
				const key = segKey(rep.repId, rep.track, segIdx);
				if (this.#opts.has(key)) continue;
				const triedAt = this.#tried.get(key);
				if (triedAt !== undefined && now - triedAt < PREFETCH_TRIED_TTL_MS) continue;
				this.#tried.delete(key);
				return { ...rep, segIdx };
			}
		}
		return null;
	}

	/**
	 * One prefetch in flight, ever. The prefetcher is a background scavenger of
	 * headroom, and a single ordered channel to the host means concurrency here
	 * would only stack speculative megabytes in front of live traffic.
	 */
	kick(): void {
		if (this.#closed || this.#busy) return;
		if (!this.#linkIsIdle()) return;
		const want = this.next();
		if (!want) return;
		this.#busy = true;
		const key = segKey(want.repId, want.track, want.segIdx);
		// Marked at the attempt, not at the outcome: success and failure are both
		// "spent" (see PREFETCH_TRIED_TTL_MS). Insertion order is time order, so
		// the first key is always the oldest when pruning.
		this.#tried.set(key, performance.now());
		while (this.#tried.size > MESH_CACHE_KEYS) {
			const oldest = this.#tried.keys().next();
			if (oldest.done) break;
			this.#tried.delete(oldest.value);
		}
		const run = this.#opts.fetch(want.repId, want.track, want.segIdx, this.#abort.signal);
		this.#inFlight.set(key, run);
		run
			.then((bytes) => {
				this.#prefetched += bytes.byteLength;
				this.#opts.onPrefetched(bytes.byteLength);
			})
			.catch(() => {
				// Speculation that did not pan out. The live path retries for real;
				// the tried-memory above already keeps this from repeating (past the
				// end of the film, that is every scan).
			})
			.finally(() => {
				this.#inFlight.delete(key);
				this.#busy = false;
				this.kick();
			});
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		// Before anything else settles: an in-flight prefetch must reject as an
		// abort, not fall back into a transport that is going away.
		this.#abort.abort();
		this.#plan = null;
		this.#tried.clear();
		this.#inFlight.clear();
	}
}
