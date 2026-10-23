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
 * The parts: cache.ts is what a guest holds, tracker.ts is the host's record of
 * who holds what, peers.ts is a guest's choice of whom to ask, prefetch.ts is
 * the fetch-diversity scavenger that makes the caches worth asking. This file
 * is the transport between them: requests out, replies in, and the one fetch
 * that tries a peer and always ends at the host.
 */

import type { SegmentFetcher } from '$lib/media/shaka/scheme';
import { INIT_SEGMENT, segKey, type Track } from '$lib/protocol/control';
import type { PeerLink, PeerNetwork } from '$lib/rtc/connection';
import {
	MESH_CACHE_BYTES,
	MESH_CACHE_KEYS,
	SegmentCache,
	looksLikeFragment
} from '$lib/mesh/cache';
import { PeerScores, SourceTable } from '$lib/mesh/peers';
import { Prefetcher } from '$lib/mesh/prefetch';
import { Tracker } from '$lib/mesh/tracker';

export { MESH_CACHE_BYTES, MESH_CACHE_KEYS } from '$lib/mesh/cache';
export {
	EMPTY_SOURCE_TTL_MS,
	MAX_OUTSTANDING_PER_PEER,
	MIN_PEER_BPS,
	OPTIMISTIC_BPS,
	SOURCE_TTL_MS
} from '$lib/mesh/peers';
export { PREFETCH_DEPTH, PREFETCH_MARGIN, PREFETCH_QUIET_MS } from '$lib/mesh/prefetch';

/** PLAN.md 7, Phase 5: batch announcements, do not spam per segment. */
export const ANNOUNCE_MIN_MS = 1000;

/** Segments ahead of the current request to ask the tracker about, in one query. */
export const SOURCE_LOOKAHEAD = 8;

export const SOURCES_TIMEOUT_MS = 3000;

/** No bytes at all from a peer for this long means it is not coming. */
export const PEER_PROGRESS_MS = 4000;

/** Ceiling on a peer fetch however slowly it trickles. The host is faster than this. */
export const PEER_DEADLINE_MS = 15_000;

const WATCHDOG_MS = 500;

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
	/**
	 * The film this mesh carries (`Ready.film`). Stamped on every request and
	 * announcement, and checked on every one received: a segment key is only
	 * content-addressing within one film. A guest builds a mesh per film; the
	 * host's one mesh is re-pointed with `setFilm`.
	 */
	film: string;
	cacheBytes?: number;
};

export type Mesh = {
	/** The SegmentFetcher the shaka scheme uses. Peer first, host always. */
	fetch: SegmentFetcher;
	/** Answer another guest from our cache. null means "ask the host" - including for a film that is not ours. */
	serve(
		peerId: string,
		film: string,
		repId: number,
		track: Track,
		segIdx: number
	): Uint8Array | null;
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
	 * Heartbeat from the guest's status tick. The prefetcher's gate opens on
	 * elapsed quiet (PREFETCH_QUIET_MS) rather than on an event, so something
	 * has to look again once the link goes idle; this is that look, on an
	 * interval the guest already runs.
	 */
	tick(): void;
	/** The film's length, so the prefetcher stops at the last segment. */
	noteDuration(durationSec: number): void;
	/** Host-side tracker bookkeeping: `keys` is peerId's complete cache, not a delta. */
	handleHave(peerId: string, film: string, keys: string[]): void;
	/** Host-side tracker answer. Only peers that are still connected. */
	sources(film: string, keys: string[]): Record<string, string[]>;
	/**
	 * Host-side: a new film is on. The tracker forgets every claim, since all of
	 * them name the old film's bytes under keys the new film reuses, and from
	 * here only announcements and queries stamped with `film` are honoured.
	 */
	setFilm(film: string): void;
	readonly stats: MeshStats;
	close(): void;
};

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

export function createMesh(opts: MeshOptions): Mesh {
	const { network, hostPeerId } = opts;
	const isHost = hostPeerId === null;
	let film = opts.film;

	const cache = new SegmentCache(opts.cacheBytes ?? MESH_CACHE_BYTES, MESH_CACHE_KEYS, () =>
		scheduleAnnounce()
	);
	const tracker = new Tracker(film);
	const sourceTable = new SourceTable();
	const scores = new PeerScores();

	/** Keys with a sourcesReq in flight, so a burst of fetches asks once. */
	const asking = new Set<string>();
	const pendingSources = new Map<
		number,
		{ keys: string[]; timer: ReturnType<typeof setTimeout> }
	>();
	const pendingSeg = new Map<number, PeerReq>();
	const uploadedTo = new Map<string, number>();
	const unsubs = new Map<string, () => void>();

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

	const prefetcher = new Prefetcher({
		has: (key) => cache.has(key),
		fetch: (repId, track, segIdx, signal) => fetch(repId, track, segIdx, signal),
		onPrefetched: () => {}
	});

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
		link.channels.sendControl({ t: 'have', film, keys });
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

	/** The best peer for this key, or null for "ask the host". */
	function pick(key: string): PeerLink | null {
		const now = performance.now();
		const peers = sourceTable.get(key, now);
		if (!peers) return null;
		return scores.pick(peers, network, hostPeerId, outstanding, now);
	}

	// ---- tracker queries (guest -> host) ------------------------------------

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
			if (!sourceTable.wantsAsk(key, now)) continue;
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
		link.channels.sendControl({ t: 'sourcesReq', reqId, film, keys: want });
	}

	/** `sources` is whatever arrived on the wire: decodeControl types it, it does not check it. */
	function onSourcesRes(reqId: number, sources: unknown): void {
		const pending = pendingSources.get(reqId);
		if (!pending) return;
		pendingSources.delete(reqId);
		clearTimeout(pending.timer);

		const now = performance.now();
		const answer = (typeof sources === 'object' && sources !== null ? sources : {}) as Record<
			string,
			unknown
		>;
		for (const key of pending.keys) {
			asking.delete(key);
			const peers = answer[key];
			// Every requested key gets an entry, including the empty answer: "nobody
			// has this" is information, and it is what keeps us from re-asking on
			// every fetch -- though an empty entry earns only the short TTL (see
			// peers.ts), because the prefetcher makes it false on purpose, soon.
			sourceTable.remember(
				key,
				Array.isArray(peers) ? peers.filter((p): p is string => typeof p === 'string') : [],
				now
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
			// Admit the reply before asking for it (channel.ts expectInbound).
			link.channels.expectInbound(reqId);
			link.channels.sendControl({ t: 'segReq', reqId, repId, track, segIdx, film });
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
		scores.forget(peerId);

		for (const req of [...pendingSeg.values()]) {
			if (req.peerId === peerId) req.settle(new Error(`mesh: peer ${peerId} left`));
		}

		// Tracker: a peer that left holds nothing, and answering with it would cost
		// the asker a round trip to a peer that is not there.
		tracker.forget(peerId);
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
		const riding = prefetcher.inFlight(key);
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
					scores.recordRate(link.peerId, bytes.byteLength, performance.now() - startedAt);
					scores.reward(link.peerId);
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
					if (err instanceof PeerMiss) sourceTable.drop(key, link.peerId);
					else scores.penalise(link.peerId, performance.now());
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
	 * The fetch the Shaka scheme actually gets: tells the prefetcher where the
	 * player is and that the link is busy, then fetches. Only Shaka's own
	 * requests move the prefetch window; the prefetcher itself calls plain
	 * `fetch` above.
	 */
	function liveFetch(
		repId: number,
		track: Track,
		segIdx: number,
		signal: AbortSignal
	): Promise<Uint8Array> {
		if (isHost) return fetch(repId, track, segIdx, signal);

		if (segIdx !== INIT_SEGMENT) prefetcher.noteLive(repId, track, segIdx);
		prefetcher.liveStarted();
		return fetch(repId, track, segIdx, signal).then(
			(bytes) => {
				prefetcher.liveSettled();
				return bytes;
			},
			(err) => {
				prefetcher.liveSettled();
				throw err;
			}
		);
	}

	return {
		fetch: liveFetch,

		serve(
			peerId: string,
			forFilm: string,
			repId: number,
			track: Track,
			segIdx: number
		): Uint8Array | null {
			if (closed || forFilm !== film) return null;
			const bytes = cache.get(segKey(repId, track, segIdx));
			if (!bytes) return null;
			uploaded += bytes.byteLength;
			uploadedTo.set(peerId, (uploadedTo.get(peerId) ?? 0) + bytes.byteLength);
			return bytes;
		},

		announce: scheduleAnnounce,

		setPlan(slot: number, of: number, rungs: number[]): void {
			if (closed || isHost) return;
			prefetcher.setPlan(slot, of, rungs);
		},

		tick(): void {
			if (closed || isHost) return;
			prefetcher.kick();
		},

		noteDuration(durationSec: number): void {
			prefetcher.noteDuration(durationSec);
		},

		handleHave(peerId: string, forFilm: string, keys: string[]): void {
			if (closed) return;
			tracker.handleHave(peerId, forFilm, keys);
		},

		sources(forFilm: string, keys: string[]): Record<string, string[]> {
			if (closed) return {};
			// Connected peers only. A stale name here is a round trip the asker
			// spends on nobody.
			return tracker.sources(forFilm, keys, (id) => network.get(id) !== undefined);
		},

		setFilm(next: string): void {
			if (next === film) return;
			film = next;
			tracker.setFilm(next);
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
				prefetched: prefetcher.prefetched
			};
		},

		close(): void {
			if (closed) return;
			closed = true;
			// Before anything else settles: an in-flight prefetch must reject as an
			// abort, not fall back into a transport that is going away.
			prefetcher.close();
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
			sourceTable.clear();
			tracker.clear();
			scores.clear();
			uploadedTo.clear();
		}
	};
}
