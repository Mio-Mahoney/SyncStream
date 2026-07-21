/**
 * Instrumentation (PLAN.md Phase 0, 8, 9).
 *
 * One mutable rune object that every layer writes into and two readers consume:
 * the `?debug` overlay, and the e2e suite through `window.__syncstream`. PLAN.md
 * 8 makes this the oracle for every acceptance criterion, so the numbers here
 * are the product's own measurements rather than a parallel set kept for tests.
 * A test that asserts against a value the app does not itself use is testing a
 * fiction.
 *
 * `candidateType` is the load-bearing field. PLAN.md 9 defers TURN and promises
 * to revisit it with data: every `relay` candidate is a connection that would
 * have needed TURN, every `host`/`srflx` one that did not. Note the wrinkle that
 * falls out of the STUN-only RTC_CONFIG -- with no TURN server configured a
 * relay candidate can never be gathered, so in *this* build the §9 signal is
 * `iceState === 'failed'`, which is the same population counted from the other
 * side. Both fields are collected from day one for that reason.
 *
 * Naming: this file is `.svelte.ts` and not `.ts` because runes outside a
 * component are only compiled in a `.svelte.js`/`.svelte.ts` module. In a plain
 * `.ts` file `$state` is an undefined identifier at runtime.
 *
 * Import-time side effects: none. The module is pulled in by SSR-less builds and
 * by the prerender pass, so `window` is touched only inside functions.
 */

import type { CandidateType } from '$lib/rtc/ice';
import type { MeshStats } from '$lib/mesh/mesh';
import { setUplinkCap } from '$lib/rtc/channel';

/**
 * One peer link, from this machine's point of view. On the host that is one
 * entry per guest; on a guest it is the host, plus any mesh peers Phase 5 adds.
 */
export type PeerStat = {
	peerId: string;
	name: string;
	/** The remote's role, not ours. */
	role: 'host' | 'guest';
	/** Bytes/sec, matching ChannelStats.throughputBps and its 2s window. */
	throughputBps: number;
	/** Seconds of media buffered past the playhead. Read off the peer's status. */
	bufferedAhead: number;
	rung: number | null;
	/** Milliseconds, the min-RTT sample ClockSync selected. */
	rtt: number;
	candidateType: CandidateType;
	/**
	 * Bytes sitting in SCTP, matching ChannelStats.outboundQueue: the data and
	 * control channels summed. Not the gate's own reading -- backpressure is
	 * measured against `data.bufferedAmount` alone, so this sits slightly above
	 * it and can exceed HIGH_WATER on control traffic without the gate being at
	 * fault. Read it as link occupancy, not as the gate's input.
	 */
	outboundQueue: number;
};

export type SyncStreamStats = {
	role: 'host' | 'guest' | null;
	/** Room code, not the URL. */
	room: string | null;
	/** Which rendezvous strategy actually carried the connection (PLAN.md 4.6). */
	strategy: string | null;
	/** RTCPeerConnection.iceConnectionState of the primary link. */
	iceState: string;
	/** PLAN.md 9. The measurement that decides TURN. */
	candidateType: CandidateType;
	/** Bytes/sec across our links. */
	throughputBps: number;
	/** Seconds of media buffered past our own playhead. */
	bufferedAhead: number;
	/** Milliseconds to the host. */
	rtt: number;
	/** Milliseconds to add to our clock to get the host's. Host-side: 0. */
	clockOffset: number;
	/** Seconds, signed; positive means we are behind the host (GuestSync.drift). */
	drift: number;
	/** Rung currently being played, null before the first variant is chosen. */
	rung: number | null;
	/** Rungs the origin is willing to advertise right now (PLAN.md 4.2). */
	availableRungs: number[];
	/** Segment requests outstanding. */
	segmentQueue: number;
	playing: boolean;
	/** Seconds. The media element's currentTime. */
	mediaTime: number;
	/** PLAN.md 4.3 tier of the host's file: 'direct' | 'transcode' | 'reject'. */
	tier: string | null;
	/** Names the readiness barrier is blocked on (PLAN.md Phase 3). */
	waitingOn: string[];
	peers: PeerStat[];
	/**
	 * Time to first frame in milliseconds, null until it happens. The Phase 0
	 * baseline and the Phase 2 acceptance criterion are both this number.
	 * Measured from the last `markTtffStart()`/`resetStats()`, or from page
	 * navigation if neither has been called.
	 */
	ttff: number | null;
	/**
	 * Phase 5 mesh accounting, refreshed on the guest's status tick. Null on
	 * the host (which is the origin, not a mesh peer) and before a guest's
	 * host link is up. `fromPeers` and `uploaded` are what prove the mesh
	 * moved bytes that never crossed the host's uplink.
	 */
	mesh: MeshStats | null;
};

function initial(): SyncStreamStats {
	return {
		role: null,
		room: null,
		strategy: null,
		iceState: 'new',
		candidateType: 'unknown',
		throughputBps: 0,
		bufferedAhead: 0,
		rtt: 0,
		clockOffset: 0,
		drift: 0,
		rung: null,
		availableRungs: [],
		segmentQueue: 0,
		playing: false,
		mediaTime: 0,
		tier: null,
		waitingOn: [],
		peers: [],
		ttff: null,
		mesh: null
	};
}

/**
 * The live object. Deeply reactive, so `stats.peers[0].rtt = 12` re-renders the
 * overlay. Exported as a const and mutated in place: a rune module cannot export
 * a reassigned binding, and every importer holds this identity.
 */
export const stats: SyncStreamStats = $state(initial());

/**
 * `performance.now()` reading the current attempt started at. Zero means page
 * navigation, which is the honest default: on a fresh load nothing has happened
 * yet, and it is also what an e2e run measuring from `page.goto` wants.
 */
let ttffOrigin = 0;

/**
 * Anchors the TTFF clock to the moment the user asked for video -- host file
 * select, or guest join -- so the number means what PLAN.md 2 measures rather
 * than including however long the tab sat on the landing page.
 */
export function markTtffStart(): void {
	ttffOrigin = performance.now();
	stats.ttff = null;
}

/** Idempotent: first frame means the first one, so later calls do not overwrite. */
export function markFirstFrame(): void {
	if (stats.ttff !== null) return;
	stats.ttff = performance.now() - ttffOrigin;
}

/** Back to a fresh session. Restarts the TTFF clock: a reset is a new attempt. */
export function resetStats(): void {
	Object.assign(stats, initial());
	ttffOrigin = performance.now();
}

const PEER_DEFAULTS: Omit<PeerStat, 'peerId'> = {
	name: '',
	role: 'guest',
	throughputBps: 0,
	bufferedAhead: 0,
	rung: null,
	rtt: 0,
	candidateType: 'unknown',
	outboundQueue: 0
};

/**
 * Upsert by peerId. Here rather than at each call site because the alternative
 * is four modules each writing their own find-or-push against the same array and
 * one of them getting it wrong. `role` defaults to 'guest'; pass it on the first
 * upsert for a link where that is not true.
 */
export function updatePeer(peerId: string, patch: Partial<Omit<PeerStat, 'peerId'>>): void {
	const existing = stats.peers.find((p) => p.peerId === peerId);
	if (existing) {
		Object.assign(existing, patch);
		return;
	}
	stats.peers.push({ ...PEER_DEFAULTS, peerId, name: peerId, ...patch });
}

export function removePeer(peerId: string): void {
	const i = stats.peers.findIndex((p) => p.peerId === peerId);
	if (i !== -1) stats.peers.splice(i, 1);
}

/**
 * A plain, deep, JSON-serializable copy.
 *
 * This exists because `stats` is a Proxy. A proxy carries internal slots, so
 * `structuredClone` on one throws DataCloneError -- and that is the algorithm
 * behind returning a value from Playwright's `page.evaluate`. Handing the live
 * object across CDP is therefore not a "may not serialize cleanly" risk, it is a
 * throw. `$state.snapshot` walks the proxy and rebuilds plain objects and
 * arrays, which is what crosses.
 */
export function snapshotStats(): SyncStreamStats {
	return $state.snapshot(stats);
}

export type SyncStreamOracle = {
	/** The live rune object. Read it in-page; do not return it from page.evaluate. */
	readonly stats: SyncStreamStats;
	/** What an e2e test polls. Plain data, safe across the CDP boundary. */
	snapshot(): SyncStreamStats;
	/**
	 * Shape this page's outbound segment bytes, in BITS/sec, or null to unshape.
	 *
	 * PLAN.md 8 says to drive the network-dependent criteria with CDP
	 * `Network.emulateNetworkConditions`. That does not work: it leaves WebRTC
	 * untouched (measured: 233 Mbps through a channel "capped" at 1.5 Mbps). So
	 * the tests shape the sender instead, which is what a constrained uplink
	 * physically is.
	 */
	throttle(bitsPerSec: number | null): void;
};

declare global {
	interface Window {
		__syncstream?: SyncStreamOracle;
	}
}

/**
 * PLAN.md 8: `window.__syncstream` is the oracle. Unconditional, not gated on
 * `?debug` -- the flag controls whether a human sees the overlay, and a test
 * should assert against the same build a user runs, not a differently
 * instrumented one.
 */
export function exposeTestOracle(): void {
	if (typeof window === 'undefined') return;
	window.__syncstream = {
		get stats() {
			return stats;
		},
		snapshot: snapshotStats,
		throttle: (bitsPerSec) => setUplinkCap(bitsPerSec === null ? null : bitsPerSec / 8)
	};
}

/**
 * The `?debug` flag from PLAN.md Phase 0. `?debug=0` and `?debug=false` read as
 * off, so a link can carry the flag without forcing it on.
 */
export function isDebug(): boolean {
	if (typeof window === 'undefined') return false;
	// Not SvelteURLSearchParams: this instance is read once and dropped, and the
	// flag cannot change without a navigation. Nothing here is reactive state.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const v = new URLSearchParams(window.location.search).get('debug');
	if (v === null) return false;
	return v !== '0' && v !== 'false';
}
