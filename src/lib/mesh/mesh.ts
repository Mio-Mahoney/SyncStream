/**
 * Mesh distribution (PLAN.md 7, Phase 5).
 *
 * The host's uplink, not the code, is the binding constraint on room size:
 * 1080p at ~8 Mbps times three guests is 24 Mbps of sustained upload, more than
 * most home connections have. The protocol is already pull-based and
 * content-addressed, so a guest holding a segment can answer for it and the
 * host's uplink stops being the only transport in the system.
 *
 * This slots in BELOW the Shaka scheme handler: it is a `SegmentFetcher` that
 * wraps another `SegmentFetcher`. Shaka keeps asking for URIs and neither knows
 * nor cares which peer answered.
 *
 * The invariant everything here is subordinate to: THE HOST IS AUTHORITATIVE AND
 * ALWAYS AVAILABLE. Any segment is always fetchable from the host, so every peer
 * path ends in a fall back to `fetchFromHost` on timeout, error, or garbage. The
 * mesh is an optimization and it may never be the reason a segment does not
 * arrive. Anything here that cannot be made reliable is instead made harmless.
 *
 * A guest serving a segment to another guest is the same code path as the host
 * serving one: `sendControl(segReq)` out, `onSegment` back, with the framing and
 * backpressure of rtc/channel.ts underneath. There is no second protocol here,
 * and there is no guest-to-guest traffic other than this exchange.
 *
 * FETCH DIVERSITY (the prefetcher, PLAN.md 11's equilibrium escape). A purely
 * reactive mesh fails the Phase 5 criterion structurally: Phase 3 keeps every
 * guest's playhead and buffer aligned, so all of them want segment N in the
 * same instant, the announce coalesce plus a tracker round trip means nobody's
 * cache is ever a useful answer for anybody else, every guest splits the host
 * uplink evenly, and every estimator reads a fraction that never selects
 * native - the measured, self-reinforcing 720p equilibrium. The escape is to
 * make the caches diverge on purpose: the host deals each guest a stripe
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
 * of the host, and upshifts by itself. Prefetch runs only while our own
 * buffer is healthy, so it spends only genuine headroom, and every prefetch
 * rides the ordinary fetch path below - peer first, host always - so the
 * invariant above is untouched: a wrong, stale or missing plan costs
 * duplicate host fetches, never a segment.
 */

import type { SegmentFetcher } from '$lib/media/shaka/scheme';
import { NATIVE_REP, SEGMENT_TARGET_SEC } from '$lib/media/types';
import { INIT_SEGMENT, parseSegKey, segKey, type Track } from '$lib/protocol/control';
import type { PeerLink, PeerNetwork } from '$lib/rtc/connection';

/**
 * What a guest keeps around to serve others.
 *
 * Sized off the sync engine rather than off the file: Phase 3 holds every
 * playhead within ~100ms of the host's and the readiness barrier stops the room
 * when one guest falls behind, so the segments a peer can plausibly want are the
 * ones from the last few seconds. 64MB is ~60s of 8 Mbps native video, which is
 * an order of magnitude more window than the room can actually spread across,
 * and it is paid on top of Shaka's own buffer inside the Phase 2 memory budget.
 */
export const MESH_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * A byte cap alone would let thousands of small segments in, and every cached
 * key is a key in every `have` we send. This bounds the announce.
 */
export const MESH_CACHE_KEYS = 512;

/** PLAN.md 7, Phase 5: batch announcements, do not spam per segment. */
export const ANNOUNCE_MIN_MS = 1000;

/** How long a tracker answer is worth acting on before we ask again. */
export const SOURCE_TTL_MS = 15_000;

/**
 * How long "nobody has this" is worth believing. Much shorter than
 * SOURCE_TTL_MS, and the difference is load-bearing for the prefetcher: an
 * owner fills its stripe just ahead of the room's aligned fetches, so a
 * segment's holder routinely appears BETWEEN our last ask and our fetch. Under
 * one shared TTL the empty answer blinds us for 15s and every fetch the
 * prefetcher set up for a peer lands on the host anyway. Re-asking empties
 * every few seconds keeps the last ask inside the announce-to-fetch gap;
 * non-empty answers keep the long TTL, since a claim only goes bad by
 * eviction, which PeerMiss already handles.
 */
export const EMPTY_SOURCE_TTL_MS = 4000;

/** Segments ahead of the current request to ask the tracker about, in one query. */
export const SOURCE_LOOKAHEAD = 8;

export const SOURCES_TIMEOUT_MS = 3000;

/** No bytes at all from a peer for this long means it is not coming. */
export const PEER_PROGRESS_MS = 4000;

/** Ceiling on a peer fetch however slowly it trickles. The host is faster than this. */
export const PEER_DEADLINE_MS = 15_000;

/** Requests we will stack on one peer before preferring someone else. */
export const MAX_OUTSTANDING_PER_PEER = 3;

/** Below this a peer is not worth the round trip, and the host takes it. */
export const MIN_PEER_BPS = 250_000;

/**
 * What we credit a peer that has never delivered to us. A pure measurement reads
 * zero for an unproven peer, would never pick it, and the mesh would never
 * bootstrap. This is the guess that buys the sample which replaces it.
 */
export const OPTIMISTIC_BPS = 2_000_000;

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
 * Prefetch only while our own buffer is at least this many seconds deep.
 *
 * This is the governor that makes prefetch spend only genuine headroom: if the
 * room cannot even sustain the current rung, buffers sag, prefetch stops, and
 * the uplink goes back to live traffic in full. Comfortably above the Phase 3
 * barrier's thresholds and below a full buffer (config.ts BUFFERING_GOAL_SEC),
 * so a healthy room prefetches and a struggling one never does.
 */
export const PREFETCH_MIN_BUFFER_S = 10;

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

/** Backoff for a peer that timed out or lied, doubling per strike. */
const PENALTY_BASE_MS = 5000;
const PENALTY_MAX_MS = 60_000;

const WATCHDOG_MS = 500;

/** Bound on an untrusted peer's `have` and on a `sourcesReq` we will answer. */
const HAVE_MAX_KEYS = 1024;

/** Tracker answers we retain. Well past the lookahead window at any bitrate. */
const SOURCE_TABLE_MAX = 4096;

const RATE_ALPHA = 0.3;

/**
 * Mesh reqIds live in the top half of the u32 space (the wire header carries a
 * u32) so they cannot collide with the reqIds the room's own host fetcher mints
 * from zero. Both ride the same channel on a guest-to-guest link, and a receiver
 * that keys pending requests by reqId alone would otherwise cross them.
 */
const REQ_BASE = 0x8000_0000;
const REQ_MAX = 0xffff_ffff;

export type MeshStats = {
	cacheBytes: number;
	cacheKeys: number;
	/** Bytes that came from peers rather than costing the host's uplink. */
	fromPeers: number;
	fromHost: number;
	/** Bytes we served to peers, and to whom. */
	uploaded: number;
	uploadedTo: Record<string, number>;
	/** Peer fetches that fell back to the host. Non-zero is normal; growing is not. */
	fallbacks: number;
	/** Bytes pulled ahead of need by the fetch-diversity prefetcher. */
	prefetched: number;
};

export type MeshOptions = {
	network: PeerNetwork;
	/** null when we ARE the host: there is no upstream, we are it. */
	hostPeerId: string | null;
	fetchFromHost: SegmentFetcher;
	cacheBytes?: number;
};

export type Mesh = {
	/** The SegmentFetcher the shaka scheme uses. Peer first, host always. */
	fetch: SegmentFetcher;
	/** Answer another guest from our cache. null means "ask the host". */
	serve(peerId: string, repId: number, track: Track, segIdx: number): Uint8Array | null;
	/** Publish what we hold to the tracker. Coalesced to at most one send per second. */
	announce(): void;
	/**
	 * The host's `meshPlan`: prefetch the segments where `segIdx % of === slot`,
	 * covering every rung in `rungs` (what the room is playing right now) plus
	 * rep 0. Guest-side only. Idempotent, and safe to apply late or never -
	 * without a plan the mesh is exactly the reactive Phase 5 mesh it always
	 * was.
	 */
	setPlan(slot: number, of: number, rungs: number[]): void;
	/**
	 * Our own buffered seconds, from the guest's status tick. The prefetcher's
	 * throttle: below PREFETCH_MIN_BUFFER_S it stands down entirely.
	 */
	noteHealth(bufferedAheadSec: number): void;
	/** The film's length, so the prefetcher stops at the last segment. */
	noteDuration(durationSec: number): void;
	/** Host-side tracker bookkeeping: `keys` is peerId's complete cache, not a delta. */
	handleHave(peerId: string, keys: string[]): void;
	/** Host-side tracker answer. Only peers that are still connected. */
	sources(keys: string[]): Record<string, string[]>;
	readonly stats: MeshStats;
	close(): void;
};

type SourceEntry = { peers: string[]; at: number };
type Penalty = { strikes: number; until: number };

type PeerReq = {
	peerId: string;
	deadline: number;
	/** Link-level received bytes at the last observed progress, for the stall check. */
	lastBytes: number;
	lastProgressAt: number;
	settle(err: Error | null, bytes?: Uint8Array): void;
};

function abortError(): DOMException {
	return new DOMException('mesh: peer fetch aborted', 'AbortError');
}

/**
 * The peer answered `segErr`: it announced this segment and has since evicted
 * it. That is a stale tracker entry, not a peer that misbehaved, and the two
 * deserve different responses -- forget the claim, keep the peer.
 */
class PeerMiss extends Error {}

/**
 * A cheap honesty check on what a peer handed us.
 *
 * We cannot verify the *content* of a segment: the key is content-addressing by
 * convention, not by digest, and neither segReq/segData nor the frame header
 * carries a hash to check against. So this catches the failures that are
 * detectable -- an empty body, a truncated transfer, HTML, a peer answering with
 * something that is not a fragment at all -- and the undetectable case (a
 * well-formed fragment for the wrong segIdx) is caught downstream by Shaka
 * refusing the append, which retries, by which point the peer is penalised and
 * the retry goes to the host. Adding a digest to the protocol would close this,
 * and the protocol is a fixed contract here.
 */
const FRAGMENT_BOXES = new Set(['moof', 'styp', 'sidx', 'emsg']);

function looksLikeFragment(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 8) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const size = view.getUint32(0);
	// size 1 defers to a 64-bit largesize; 0 means "to the end". Anything else
	// must describe a box that fits in what we received.
	if (size !== 0 && size !== 1 && (size < 8 || size > bytes.byteLength)) return false;
	let type = '';
	for (let i = 4; i < 8; i++) type += String.fromCharCode(bytes[i]);
	return FRAGMENT_BOXES.has(type);
}

/** Byte- and count-capped LRU. `onChange` fires only when the key SET moves. */
class SegmentCache {
	readonly #map = new Map<string, Uint8Array>();
	readonly #cap: number;
	readonly #maxKeys: number;
	readonly #onChange: () => void;
	#bytes = 0;

	constructor(cap: number, maxKeys: number, onChange: () => void) {
		this.#cap = cap;
		this.#maxKeys = maxKeys;
		this.#onChange = onChange;
	}

	get(key: string): Uint8Array | undefined {
		const val = this.#map.get(key);
		if (!val) return undefined;
		// Re-insert: Map iterates in insertion order, so this is the recency list.
		// A segment a peer asked us for is a segment worth keeping.
		this.#map.delete(key);
		this.#map.set(key, val);
		return val;
	}

	has(key: string): boolean {
		return this.#map.has(key);
	}

	put(key: string, val: Uint8Array): void {
		// One segment larger than the whole cap would evict everything and then sit
		// there alone. Sparse-keyframe files produce them.
		if (val.byteLength > this.#cap) return;
		const prev = this.#map.get(key);
		if (prev) {
			this.#bytes -= prev.byteLength;
			this.#map.delete(key);
		}
		this.#map.set(key, val);
		this.#bytes += val.byteLength;
		let changed = prev === undefined;
		while (this.#bytes > this.#cap || this.#map.size > this.#maxKeys) {
			const oldest = this.#map.keys().next();
			if (oldest.done || oldest.value === key) break;
			const evicted = this.#map.get(oldest.value);
			this.#map.delete(oldest.value);
			if (evicted) this.#bytes -= evicted.byteLength;
			changed = true;
		}
		if (changed) this.#onChange();
	}

	keys(): string[] {
		return [...this.#map.keys()];
	}

	get size(): number {
		return this.#map.size;
	}

	get bytes(): number {
		return this.#bytes;
	}

	clear(): void {
		this.#map.clear();
		this.#bytes = 0;
	}
}

export function createMesh(opts: MeshOptions): Mesh {
	const { network, hostPeerId } = opts;
	const isHost = hostPeerId === null;

	const cache = new SegmentCache(opts.cacheBytes ?? MESH_CACHE_BYTES, MESH_CACHE_KEYS, () =>
		scheduleAnnounce()
	);

	/** Tracker answers: key -> peers that claimed it, with the time we heard it. */
	const table = new Map<string, SourceEntry>();
	/** Keys with a sourcesReq in flight, so a burst of fetches asks once. */
	const asking = new Set<string>();
	const pendingSources = new Map<
		number,
		{ keys: string[]; timer: ReturnType<typeof setTimeout> }
	>();
	const pendingSeg = new Map<number, PeerReq>();

	/** Our own throughput measurement per peer, in bits/sec, EWMA over completed fetches. */
	const rates = new Map<string, number>();
	const penalties = new Map<string, Penalty>();
	const uploadedTo = new Map<string, number>();
	const unsubs = new Map<string, () => void>();

	/** Host-side tracker. Both directions, so a peer leaving is a cheap removal. */
	const byKey = new Map<string, Set<string>>();
	const byPeer = new Map<string, Set<string>>();

	let reqSeq = REQ_BASE;
	let watchdog: ReturnType<typeof setInterval> | null = null;
	let announceTimer: ReturnType<typeof setTimeout> | null = null;
	let lastAnnounceAt = Number.NEGATIVE_INFINITY;
	let announcedSig: string | null = null;
	let fromPeers = 0;
	let fromHost = 0;
	let uploaded = 0;
	let fallbacks = 0;
	let prefetched = 0;
	let closed = false;

	// ---- prefetch state (see the header's FETCH DIVERSITY) -------------------

	let plan: { slot: number; of: number; rungs: number[] } | null = null;
	/** The segIdx of the most recent LIVE video fetch, i.e. where Shaka is. */
	let liveEdge = -1;
	/** The rung those live fetches are asking for. */
	let liveRep: number | null = null;
	/** Whether this film has audio at all, learned from the traffic itself. */
	let sawAudio = false;
	let health = 0;
	let maxSegIdx = Number.POSITIVE_INFINITY;
	let prefetchBusy = false;
	const prefetchAbort = new AbortController();
	/** key -> when it was attempted. See PREFETCH_TRIED_TTL_MS for why attempts. */
	const prefetchTried = new Map<string, number>();
	/**
	 * The prefetch currently in flight, so a live fetch for the same key rides
	 * it instead of starting a second full download. Under the criterion's
	 * contended uplink a native segment trickles for tens of seconds, and the
	 * playhead can reach it mid-transfer; without this the owner then pays for
	 * the same megabytes twice, on the one link that has none to spare.
	 */
	const prefetchInFlight = new Map<string, Promise<Uint8Array>>();

	function nextReqId(): number {
		if (reqSeq >= REQ_MAX) reqSeq = REQ_BASE;
		return reqSeq++;
	}

	// ---- announce (guest -> tracker) ----------------------------------------

	/**
	 * `keys` is a SNAPSHOT of what is cached, not a delta.
	 *
	 * PLAN.md 7, Phase 5 requires that eviction retract: announcing a segment we
	 * have since dropped sends a peer on a round trip that ends in segErr, and the
	 * `have` message carries no way to say "no longer". A snapshot retracts by
	 * omission, is idempotent in the same way `state` is, and costs nothing to
	 * send because MESH_CACHE_KEYS bounds it at a few KB. The tracker replaces the
	 * peer's set wholesale, so it cannot drift from the truth by more than the
	 * announce interval.
	 */
	function flushAnnounce(): void {
		announceTimer = null;
		if (closed || isHost) return;
		lastAnnounceAt = performance.now();

		const keys = cache.keys();
		const sig = keys.join(' ');
		if (sig === announcedSig) return;

		const link = network.get(hostPeerId);
		if (!link) {
			// The tracker is not reachable yet. Retry rather than mark this set as
			// announced: lastAnnounceAt just moved, so this cannot spin.
			scheduleAnnounce();
			return;
		}
		link.channels.sendControl({ t: 'have', keys });
		announcedSig = sig;
	}

	function scheduleAnnounce(): void {
		if (closed || isHost || announceTimer !== null) return;
		const wait = Math.max(0, ANNOUNCE_MIN_MS - (performance.now() - lastAnnounceAt));
		announceTimer = setTimeout(flushAnnounce, wait);
	}

	// ---- peer selection -----------------------------------------------------

	function outstanding(peerId: string): number {
		let n = 0;
		for (const req of pendingSeg.values()) if (req.peerId === peerId) n++;
		return n;
	}

	function rateOf(link: PeerLink): number {
		const measured = rates.get(link.peerId);
		if (measured === undefined) return OPTIMISTIC_BPS;
		// stats.throughputBps is a 2s window, so it reads zero on an idle link and
		// a peer that served us well would never be picked again. Live traffic can
		// raise the estimate; it never lowers it below what the peer has delivered.
		//
		// ChannelStats.throughputBps is BYTES per second (channel.ts sums received
		// byte counts; stats.svelte.ts documents it as bytes/sec). Everything on
		// this side of the module -- `rates`, MIN_PEER_BPS, OPTIMISTIC_BPS -- is
		// bits per second. Convert, or the comparison understates a live peer by
		// 8x and benches peers that are comfortably fast enough.
		return Math.max(measured, link.channels.stats.throughputBps * 8);
	}

	/**
	 * The best peer for this key, or null for "ask the host".
	 *
	 * Best throughput and fewest outstanding requests (PLAN.md 7, Phase 5). The
	 * divisor is not a fairness knob: a peer already carrying our requests will
	 * queue this one behind them on its single ordered channel, so its effective
	 * rate for us really is divided.
	 */
	function pick(key: string): PeerLink | null {
		const entry = table.get(key);
		if (!entry) return null;
		const now = performance.now();
		if (now - entry.at > SOURCE_TTL_MS) {
			table.delete(key);
			return null;
		}

		let best: PeerLink | null = null;
		let bestScore = 0;
		for (const peerId of entry.peers) {
			if (peerId === hostPeerId) continue; // the host is the fallback, not a mesh peer
			const link = network.get(peerId);
			if (!link) continue;
			const penalty = penalties.get(peerId);
			if (penalty && now < penalty.until) continue;
			const out = outstanding(peerId);
			if (out >= MAX_OUTSTANDING_PER_PEER) continue;
			const rate = rateOf(link);
			if (rate < MIN_PEER_BPS) continue;
			const score = rate / (1 + out);
			if (score > bestScore) {
				bestScore = score;
				best = link;
			}
		}
		return best;
	}

	function recordRate(peerId: string, bytes: number, elapsedMs: number): void {
		const bps = (bytes * 8 * 1000) / Math.max(elapsedMs, 1);
		const prev = rates.get(peerId);
		rates.set(peerId, prev === undefined ? bps : prev * (1 - RATE_ALPHA) + bps * RATE_ALPHA);
	}

	function reward(peerId: string): void {
		const p = penalties.get(peerId);
		if (!p) return;
		p.strikes -= 1;
		p.until = 0;
		if (p.strikes <= 0) penalties.delete(peerId);
	}

	function penalise(peerId: string): void {
		const p = penalties.get(peerId) ?? { strikes: 0, until: 0 };
		p.strikes = Math.min(p.strikes + 1, 8);
		p.until = performance.now() + Math.min(PENALTY_BASE_MS * 2 ** (p.strikes - 1), PENALTY_MAX_MS);
		penalties.set(peerId, p);
	}

	// ---- tracker queries (guest -> host) ------------------------------------

	/** Retracts one peer's claim on one key without touching the rest of the answer. */
	function dropSource(key: string, peerId: string): void {
		const entry = table.get(key);
		if (!entry) return;
		entry.peers = entry.peers.filter((id) => id !== peerId);
	}

	function rememberSources(key: string, peers: string[]): void {
		table.set(key, { peers, at: performance.now() });
		while (table.size > SOURCE_TABLE_MAX) {
			const oldest = table.keys().next();
			if (oldest.done || oldest.value === key) break;
			table.delete(oldest.value);
		}
	}

	/**
	 * Asks the tracker about this segment and the ones just after it.
	 *
	 * ORDER IS BY PROXIMITY TO THE PLAYHEAD, NOT RAREST-FIRST. Playback is linear:
	 * the next segment is the next question, and a segment behind the playhead is
	 * worth nothing however rare it is. Rarest-first is a torrent optimization for
	 * a swarm that can consume blocks in any order and assemble them at the end,
	 * which a video player cannot do. Nobody should "fix" this later.
	 *
	 * Shaka issues its requests in playback order, so that order is already ours;
	 * the lookahead exists only to keep the tracker round trip off the critical
	 * path, so the *next* fetch has an answer before it needs one. Fire and
	 * forget: no answer means no mesh for these segments, and the host has them.
	 */
	function refreshSources(repId: number, track: Track, segIdx: number): void {
		if (closed || isHost) return;
		const now = performance.now();
		const want: string[] = [];
		for (let i = 0; i < SOURCE_LOOKAHEAD; i++) {
			const key = segKey(repId, track, segIdx + i);
			if (cache.has(key) || asking.has(key)) continue;
			const entry = table.get(key);
			// An empty answer goes stale on its own, shorter clock: with the
			// prefetcher filling stripes just ahead of the room, "nobody has this"
			// routinely becomes wrong within seconds (see EMPTY_SOURCE_TTL_MS).
			const ttl = entry && entry.peers.length > 0 ? SOURCE_TTL_MS : EMPTY_SOURCE_TTL_MS;
			if (entry && now - entry.at < ttl) continue;
			want.push(key);
		}
		if (want.length === 0) return;

		const link = network.get(hostPeerId);
		if (!link) return;

		const reqId = nextReqId();
		for (const key of want) asking.add(key);
		const timer = setTimeout(() => {
			pendingSources.delete(reqId);
			for (const key of want) asking.delete(key);
		}, SOURCES_TIMEOUT_MS);
		pendingSources.set(reqId, { keys: want, timer });
		link.channels.sendControl({ t: 'sourcesReq', reqId, keys: want });
	}

	/** `sources` is whatever arrived on the wire: decodeControl types it, it does not check it. */
	function onSourcesRes(reqId: number, sources: unknown): void {
		const pending = pendingSources.get(reqId);
		if (!pending) return;
		pendingSources.delete(reqId);
		clearTimeout(pending.timer);

		const answer = (typeof sources === 'object' && sources !== null ? sources : {}) as Record<
			string,
			unknown
		>;
		for (const key of pending.keys) {
			asking.delete(key);
			const peers = answer[key];
			// Every requested key gets an entry, including the empty answer: "nobody
			// has this" is information, and it is what keeps us from re-asking on
			// every fetch -- though an empty entry earns only the short TTL above,
			// because the prefetcher makes it false on purpose, soon.
			rememberSources(
				key,
				Array.isArray(peers) ? peers.filter((p): p is string => typeof p === 'string') : []
			);
		}
	}

	// ---- peer fetch ---------------------------------------------------------

	function startWatchdog(): void {
		if (watchdog !== null || closed) return;
		watchdog = setInterval(sweep, WATCHDOG_MS);
	}

	function stopWatchdogIfIdle(): void {
		if (watchdog !== null && pendingSeg.size === 0) {
			clearInterval(watchdog);
			watchdog = null;
		}
	}

	/**
	 * Liveness by observed progress rather than a flat deadline. A segment is
	 * megabytes and peers are asymmetric, so one timeout is either short enough to
	 * abandon a slow peer that is working or long enough to wait on a dead one.
	 * `bytesRecv` on the link is the honest signal for "still sending".
	 *
	 * Reading it per link rather than per request is deliberate: the peer answers
	 * our requests in order over one ordered channel, so progress on any of them
	 * is proof that the ones behind it are queued and not lost.
	 */
	function sweep(): void {
		const now = performance.now();
		for (const [reqId, req] of [...pendingSeg]) {
			const link = network.get(req.peerId);
			if (!link) {
				req.settle(new Error(`mesh: peer ${req.peerId} left mid-transfer`));
				continue;
			}
			const recv = link.channels.stats.bytesRecv;
			if (recv > req.lastBytes) {
				req.lastBytes = recv;
				req.lastProgressAt = now;
			}
			if (now >= req.deadline) {
				req.settle(
					new Error(`mesh: peer ${req.peerId} exceeded ${PEER_DEADLINE_MS}ms on ${reqId}`)
				);
			} else if (now - req.lastProgressAt > PEER_PROGRESS_MS) {
				req.settle(new Error(`mesh: peer ${req.peerId} sent nothing for ${PEER_PROGRESS_MS}ms`));
			}
		}
		stopWatchdogIfIdle();
	}

	function requestFromPeer(
		link: PeerLink,
		repId: number,
		track: Track,
		segIdx: number,
		signal: AbortSignal
	): Promise<Uint8Array> {
		return new Promise<Uint8Array>((resolve, reject) => {
			if (signal.aborted) {
				reject(abortError());
				return;
			}
			const reqId = nextReqId();
			const now = performance.now();
			const onAbort = (): void => req.settle(abortError());

			const req: PeerReq = {
				peerId: link.peerId,
				deadline: now + PEER_DEADLINE_MS,
				lastBytes: link.channels.stats.bytesRecv,
				lastProgressAt: now,
				settle(err, bytes) {
					// The delete is the idempotence: whichever of the reply, the sweep,
					// the abort, or a close gets here first is the one that settles.
					if (!pendingSeg.delete(reqId)) return;
					signal.removeEventListener('abort', onAbort);
					if (err) {
						// Tell the peer to stop. An abandoned request keeps its uplink busy
						// with bytes we will not use, and peer uplink is the resource this
						// whole phase exists to spend well.
						link.channels.sendControl({ t: 'segCancel', reqId });
						link.channels.cancelInbound(reqId);
						reject(err);
					} else {
						resolve(bytes!);
					}
					stopWatchdogIfIdle();
				}
			};

			signal.addEventListener('abort', onAbort, { once: true });
			pendingSeg.set(reqId, req);
			startWatchdog();
			link.channels.sendControl({ t: 'segReq', reqId, repId, track, segIdx });
		});
	}

	// ---- link wiring --------------------------------------------------------

	/**
	 * We subscribe per link rather than per request and dispatch on reqId. The
	 * room's own host fetcher subscribes to the same events; the peerId check is
	 * what keeps its replies and ours apart even before REQ_BASE separates the id
	 * spaces.
	 */
	function wire(link: PeerLink): void {
		if (unsubs.has(link.peerId)) return;
		const offSeg = link.channels.onSegment((reqId, payload) => {
			const req = pendingSeg.get(reqId);
			if (!req || req.peerId !== link.peerId) return;
			req.settle(null, payload);
		});
		const offCtl = link.channels.onControl((msg) => {
			if (msg.t === 'segErr') {
				const req = pendingSeg.get(msg.reqId);
				if (!req || req.peerId !== link.peerId) return;
				req.settle(new PeerMiss(`mesh: peer ${link.peerId} has no ${msg.reqId}: ${msg.reason}`));
			} else if (msg.t === 'sourcesRes' && link.peerId === hostPeerId) {
				onSourcesRes(msg.reqId, msg.sources);
			}
		});
		unsubs.set(link.peerId, () => {
			offSeg();
			offCtl();
		});
	}

	function forget(peerId: string): void {
		unsubs.get(peerId)?.();
		unsubs.delete(peerId);
		rates.delete(peerId);
		penalties.delete(peerId);

		for (const req of [...pendingSeg.values()]) {
			if (req.peerId === peerId) req.settle(new Error(`mesh: peer ${peerId} left`));
		}

		// Tracker: a peer that left holds nothing, and answering with it would cost
		// the asker a round trip to a peer that is not there.
		const keys = byPeer.get(peerId);
		if (keys) {
			for (const key of keys) {
				const set = byKey.get(key);
				if (!set) continue;
				set.delete(peerId);
				if (set.size === 0) byKey.delete(key);
			}
			byPeer.delete(peerId);
		}
	}

	const offPeer = network.onPeer(wire);
	const offGone = network.onPeerGone(forget);

	// ---- the fetcher --------------------------------------------------------

	function admit(segIdx: number, key: string, bytes: Uint8Array): void {
		// The host's origin has its own cache and a second copy is dead weight. A
		// segment that arrives after close is not worth resurrecting the cache for.
		if (isHost || closed) return;
		// Init segments are never asked of a peer (see fetch), so announcing one
		// only puts a key in every `have` that nobody will ever act on.
		if (segIdx === INIT_SEGMENT) return;
		cache.put(key, bytes);
	}

	async function fetch(
		repId: number,
		track: Track,
		segIdx: number,
		signal: AbortSignal
	): Promise<Uint8Array> {
		if (closed) throw new Error('mesh: closed');
		// We are the origin. There is no upstream and nothing to cache twice.
		if (isHost) return opts.fetchFromHost(repId, track, segIdx, signal);

		const key = segKey(repId, track, segIdx);
		const hit = cache.get(key);
		if (hit) return hit;

		// Ride a prefetch already downloading these bytes rather than racing it.
		// The prefetch's own accounting covers the transfer; scheme.ts still
		// honours this caller's abort by racing the signal over us.
		const riding = prefetchInFlight.get(key);
		if (riding) return riding;

		// Init segments never enter the mesh: they are a couple of KB, they gate
		// playback start, and the host is the fastest correct answer for them.
		if (segIdx !== INIT_SEGMENT) {
			refreshSources(repId, track, segIdx);
			const link = pick(key);
			if (link) {
				const startedAt = performance.now();
				try {
					const bytes = await requestFromPeer(link, repId, track, segIdx, signal);
					if (!looksLikeFragment(bytes)) {
						throw new Error(
							`mesh: peer ${link.peerId} answered ${key} with ${bytes.byteLength} bytes that are not a fragment`
						);
					}
					recordRate(link.peerId, bytes.byteLength, performance.now() - startedAt);
					reward(link.peerId);
					fromPeers += bytes.byteLength;
					admit(segIdx, key, bytes);
					return bytes;
				} catch (err) {
					// A seek away from this range is Shaka's abort, not the peer's fault.
					signal.throwIfAborted();
					if (closed) throw err;
					fallbacks++;
					// A miss costs the peer this key; a timeout or a lie costs it our
					// custom until it has served the backoff.
					if (err instanceof PeerMiss) dropSource(key, link.peerId);
					else penalise(link.peerId);
					// One peer, then the host. Walking the candidate list would stack a
					// second timeout onto a segment the player is already waiting for,
					// and the fall back has to be genuinely reliable rather than
					// eventually reliable.
				}
			}
		}

		const bytes = await opts.fetchFromHost(repId, track, segIdx, signal);
		fromHost += bytes.byteLength;
		admit(segIdx, key, bytes);
		return bytes;
	}

	/**
	 * The fetch the Shaka scheme actually gets: notes where the player is, then
	 * fetches. Only Shaka's own requests move the edge - the prefetcher calls
	 * plain `fetch` below, and letting its speculative reads advance the edge
	 * would have the window chase itself down the film.
	 *
	 * Assignment, not max: a seek is a new edge in either direction, and a
	 * window stranded ahead of a backward seek prefetches a part of the film
	 * the room just left.
	 */
	function liveFetch(
		repId: number,
		track: Track,
		segIdx: number,
		signal: AbortSignal
	): Promise<Uint8Array> {
		if (!isHost && segIdx !== INIT_SEGMENT) {
			if (track === 'video') {
				liveEdge = segIdx;
				liveRep = repId;
				kickPrefetch();
			} else {
				sawAudio = true;
			}
		}
		return fetch(repId, track, segIdx, signal);
	}

	// ---- prefetch ------------------------------------------------------------

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
	function nextPrefetch(): { repId: number; track: Track; segIdx: number } | null {
		if (!plan || liveEdge < 0) return null;
		// Alone in the room there is nobody to serve and nothing to dedupe: a
		// solo guest already has the host's whole uplink, and speculative pulls
		// would only churn the cache against segments no one will ever ask for.
		if (plan.of < 2) return null;
		// Cheapest video rungs first (higher id = lower bitrate), our own rung
		// merged in against the plan's ~1s of lag, audio next, rep 0 last.
		const videoRungs = new Set(plan.rungs);
		if (liveRep !== null) videoRungs.add(liveRep);
		videoRungs.delete(NATIVE_REP);
		const reps: { repId: number; track: Track }[] = [...videoRungs]
			.sort((a, b) => b - a)
			.map((repId) => ({ repId, track: 'video' as const }));
		if (sawAudio) reps.push({ repId: NATIVE_REP, track: 'audio' });
		reps.push({ repId: NATIVE_REP, track: 'video' });

		const now = performance.now();
		const start = liveEdge + PREFETCH_MARGIN;
		for (const rep of reps) {
			for (let i = 0; i < PREFETCH_DEPTH; i++) {
				const segIdx = start + i;
				if (segIdx > maxSegIdx) break;
				if (segIdx % plan.of !== plan.slot) continue;
				const key = segKey(rep.repId, rep.track, segIdx);
				if (cache.has(key)) continue;
				const triedAt = prefetchTried.get(key);
				if (triedAt !== undefined && now - triedAt < PREFETCH_TRIED_TTL_MS) continue;
				prefetchTried.delete(key);
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
	function kickPrefetch(): void {
		if (closed || isHost || prefetchBusy) return;
		if (health < PREFETCH_MIN_BUFFER_S) return;
		const want = nextPrefetch();
		if (!want) return;
		prefetchBusy = true;
		const key = segKey(want.repId, want.track, want.segIdx);
		// Marked at the attempt, not at the outcome: success and failure are both
		// "spent" (see PREFETCH_TRIED_TTL_MS). Insertion order is time order, so
		// the first key is always the oldest when pruning.
		prefetchTried.set(key, performance.now());
		while (prefetchTried.size > MESH_CACHE_KEYS) {
			const oldest = prefetchTried.keys().next();
			if (oldest.done) break;
			prefetchTried.delete(oldest.value);
		}
		const run = fetch(want.repId, want.track, want.segIdx, prefetchAbort.signal);
		prefetchInFlight.set(key, run);
		run
			.then((bytes) => {
				prefetched += bytes.byteLength;
			})
			.catch(() => {
				// Speculation that did not pan out. The live path retries for real;
				// the tried-memory above already keeps this from repeating (past the
				// end of the film, that is every scan).
			})
			.finally(() => {
				prefetchInFlight.delete(key);
				prefetchBusy = false;
				kickPrefetch();
			});
	}

	return {
		fetch: liveFetch,

		serve(peerId: string, repId: number, track: Track, segIdx: number): Uint8Array | null {
			if (closed) return null;
			const bytes = cache.get(segKey(repId, track, segIdx));
			if (!bytes) return null;
			uploaded += bytes.byteLength;
			uploadedTo.set(peerId, (uploadedTo.get(peerId) ?? 0) + bytes.byteLength);
			return bytes;
		},

		announce: scheduleAnnounce,

		setPlan(slot: number, of: number, rungs: number[]): void {
			// Off the wire via guest.ts, so typed but unchecked. A nonsense plan is
			// a plan to ignore, and no plan means the reactive mesh, which works.
			if (closed || isHost) return;
			if (!Number.isInteger(slot) || !Number.isInteger(of) || of < 1 || slot < 0 || slot >= of)
				return;
			if (!Array.isArray(rungs)) return;
			const cleaned = [...new Set(rungs.filter((r) => Number.isInteger(r) && r >= 0))].sort(
				(a, b) => a - b
			);
			plan = { slot, of, rungs: cleaned };
			kickPrefetch();
		},

		noteHealth(bufferedAheadSec: number): void {
			health = Number.isFinite(bufferedAheadSec) ? bufferedAheadSec : 0;
			kickPrefetch();
		},

		noteDuration(durationSec: number): void {
			if (!Number.isFinite(durationSec) || durationSec <= 0) return;
			// The same soft bound ladder.ts derives: the last index a target-length
			// grid can hold. The real grid is cut at sync samples and may end a
			// segment or so early; the failure memory absorbs the overshoot.
			maxSegIdx = Math.max(0, Math.ceil(durationSec / SEGMENT_TARGET_SEC) - 1);
		},

		handleHave(peerId: string, keys: string[]): void {
			// `keys` came off a peer's control channel, and decodeControl types the
			// message without checking it. A guest sending us nonsense is a guest to
			// ignore, not an exception to throw through the room's dispatcher.
			if (closed || !Array.isArray(keys)) return;
			const next = new Set<string>();
			for (const key of keys) {
				if (next.size >= HAVE_MAX_KEYS) break; // a peer is untrusted; its `have` is not a memory budget
				if (typeof key === 'string' && parseSegKey(key)) next.add(key);
			}

			// Snapshot semantics, per flushAnnounce: what is absent has been evicted.
			const prev = byPeer.get(peerId);
			if (prev) {
				for (const key of prev) {
					if (next.has(key)) continue;
					const set = byKey.get(key);
					if (!set) continue;
					set.delete(peerId);
					if (set.size === 0) byKey.delete(key);
				}
			}
			for (const key of next) {
				let set = byKey.get(key);
				if (!set) {
					set = new Set();
					byKey.set(key, set);
				}
				set.add(peerId);
			}
			if (next.size === 0) byPeer.delete(peerId);
			else byPeer.set(peerId, next);
		},

		sources(keys: string[]): Record<string, string[]> {
			const out: Record<string, string[]> = {};
			if (closed || !Array.isArray(keys)) return out;
			for (const key of keys.slice(0, HAVE_MAX_KEYS)) {
				const set = byKey.get(key);
				if (!set || set.size === 0) continue;
				// Connected peers only. A stale name here is a round trip the asker
				// spends on nobody.
				const live = [...set].filter((id) => network.get(id) !== undefined);
				if (live.length > 0) out[key] = live;
			}
			return out;
		},

		get stats(): MeshStats {
			return {
				cacheBytes: cache.bytes,
				cacheKeys: cache.size,
				fromPeers,
				fromHost,
				uploaded,
				uploadedTo: Object.fromEntries(uploadedTo),
				fallbacks,
				prefetched
			};
		},

		close(): void {
			if (closed) return;
			closed = true;
			// Before anything else settles: an in-flight prefetch must reject as an
			// abort, not fall back into a transport that is going away.
			prefetchAbort.abort();
			plan = null;
			prefetchTried.clear();
			prefetchInFlight.clear();
			offPeer();
			offGone();
			for (const off of unsubs.values()) off();
			unsubs.clear();

			if (announceTimer !== null) clearTimeout(announceTimer);
			announceTimer = null;
			if (watchdog !== null) clearInterval(watchdog);
			watchdog = null;

			for (const pending of pendingSources.values()) clearTimeout(pending.timer);
			pendingSources.clear();
			asking.clear();

			// Settling rather than dropping: an in-flight fetch() sees the rejection,
			// finds `closed`, and rethrows instead of falling back into a transport
			// that is also going away.
			for (const req of [...pendingSeg.values()]) req.settle(new Error('mesh: closed'));
			pendingSeg.clear();

			cache.clear();
			table.clear();
			byKey.clear();
			byPeer.clear();
			rates.clear();
			penalties.clear();
			uploadedTo.clear();
		}
	};
}
