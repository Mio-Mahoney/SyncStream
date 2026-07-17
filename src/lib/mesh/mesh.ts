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
 */

import type { SegmentFetcher } from '$lib/media/shaka/scheme';
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
	let closed = false;

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
			if (entry && now - entry.at < SOURCE_TTL_MS) continue;
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
			// has this" is information, and it is what keeps the TTL from letting us
			// re-ask on every fetch.
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

	return {
		fetch,

		serve(peerId: string, repId: number, track: Track, segIdx: number): Uint8Array | null {
			if (closed) return null;
			const bytes = cache.get(segKey(repId, track, segIdx));
			if (!bytes) return null;
			uploaded += bytes.byteLength;
			uploadedTo.set(peerId, (uploadedTo.get(peerId) ?? 0) + bytes.byteLength);
			return bytes;
		},

		announce: scheduleAnnounce,

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
				fallbacks
			};
		},

		close(): void {
			if (closed) return;
			closed = true;
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
