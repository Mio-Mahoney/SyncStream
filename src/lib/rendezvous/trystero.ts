/**
 * The trystero strategy ladder (PLAN.md 4.6).
 *
 * trystero is rendezvous ONLY. Nothing in this file touches `makeAction`,
 * `addStream`, or any other trystero data path. A `RendezvousSession` hands
 * back the raw `RTCPeerConnection` from `room.getPeers()` and `$lib/rtc` owns
 * every byte above it. Routing media through a wrapper's data-channel API is
 * the bug we are replacing; adopting a new wrapper for it would reproduce that
 * bug with a new name.
 *
 * Packaging note: trystero 0.25 split its strategies into separate packages.
 * `trystero/mqtt` is a deprecation stub that THROWS on import. The real entry
 * points are the root export (which IS nostr) and `@trystero-p2p/mqtt`, loaded
 * with dynamic `import()` so vite code-splits mqtt's large transitive dep out of
 * the main bundle when it is never used.
 *
 * Supabase was a third strategy here and was removed: see STRATEGY_ORDER in
 * transport.ts for why (no Broadcast retention, so trystero's signaling never
 * reliably completes).
 */

import {
	STRATEGY_ORDER,
	type JoinOptions,
	type RendezvousSession,
	type SignalingTransport,
	type StrategyName
} from '$lib/rendezvous/transport';
import { RTC_CONFIG } from '$lib/rtc/ice';
import type { Room } from '@trystero-p2p/mqtt';

/** Namespaces our rooms on the shared public relays. */
const APP_ID = 'syncstream';

/**
 * How long a strategy gets to prove its relay layer is up before the ladder
 * gives up on it. Generous enough for a cold WebSocket handshake to a public
 * relay on a slow link, short enough that a dead relay does not hold a room
 * code hostage.
 */
export const CONNECT_TIMEOUT_MS = 8000;

const RELAY_POLL_MS = 50;

/**
 * `getRelaySockets` is exported as `any` by the nostr and mqtt packages. Both
 * return their relay manager's live socket map keyed by relay URL.
 */
type RelaySockets = () => Record<string, WebSocket | undefined>;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * The only honest liveness signal trystero exposes.
 *
 * trystero's `joinRoom` is synchronous and never reports that a relay came up.
 * `onJoinError` is NOT that report: every call site in
 * `@trystero-p2p/core/dist/signal-handler.mjs` and `strategy.mjs` is a
 * peer-level failure (password mismatch on offer/answer decrypt, SDP exchange
 * producing no connection, handshake timeout). None of them fire when a relay
 * is unreachable or a subscription never lands, and wiring one to reject a join
 * would reject long-connected rooms on an unrelated peer's ICE failure.
 *
 * What IS observable: the nostr and mqtt strategies register their relay
 * clients in a module-global manager and expose the underlying WebSockets via
 * `getRelaySockets()`. `strategy.mjs` awaits `initPromises` before calling
 * `subscribe`, so relay readiness gates the subscribe. One open relay is
 * enough: announces and subscriptions fan out to all of them and rendezvous
 * needs one.
 *
 * How much an OPEN socket proves differs by strategy, and the weaker case is
 * the honest one to record:
 *
 * - **nostr** exposes `client.socket` from core's `makeSocket`, whose `ready`
 *   resolves on that same socket's `onopen`. OPEN therefore does mean the
 *   subscribe is landing.
 * - **mqtt** exposes `client.stream.socket` (mqtt.js), and mqtt.js's
 *   `BufferedDuplex` assigns `.socket` in its constructor -- before the socket
 *   opens. trystero's relay promise resolves on the mqtt-level `connect` event
 *   (CONNACK), which is strictly later than the WebSocket's `onopen`. So for
 *   mqtt an OPEN socket proves the transport reached the broker, NOT that the
 *   MQTT session was accepted. A broker at its connection limit (the public
 *   ones routinely are) opens the socket and never CONNACKs, and this reports
 *   success anyway.
 *
 * That gap is bounded rather than closed: `@trystero-p2p/mqtt` exports only
 * `joinRoom`, `selfId`, `getRelaySockets`, and `defaultRelayUrls`, so the
 * client whose `connected` flag would settle it is not reachable from here.
 * The blast radius is a host that announces on an mqtt relay that never
 * subscribes; guests then burn one strategy budget before falling through,
 * which is what the ladder is for. Fixing it properly needs an upstream handle
 * on the mqtt client.
 */
async function awaitOpenRelay(
	getSockets: RelaySockets,
	strategy: StrategyName,
	signal?: AbortSignal
): Promise<void> {
	const deadline = Date.now() + CONNECT_TIMEOUT_MS;
	for (;;) {
		signal?.throwIfAborted();
		const sockets = Object.values(getSockets());
		if (sockets.some((s) => s?.readyState === WebSocket.OPEN)) return;
		if (Date.now() >= deadline) {
			throw new Error(`${strategy} relays did not connect within ${CONNECT_TIMEOUT_MS}ms`);
		}
		await sleep(RELAY_POLL_MS, signal);
	}
}

function makeSession(strategy: StrategyName, selfId: string, room: Room): RendezvousSession {
	const joinCbs = new Set<(peerId: string) => void>();
	const leaveCbs = new Set<(peerId: string) => void>();

	// trystero's onPeerJoin/onPeerLeave are single assignable slots, not an
	// emitter. Assigning one fan-out handler is what lets several consumers
	// listen; a second `room.onPeerJoin = ...` anywhere would silently evict
	// the first.
	room.onPeerJoin = (peerId) => {
		for (const cb of joinCbs) cb(peerId);
	};
	room.onPeerLeave = (peerId) => {
		for (const cb of leaveCbs) cb(peerId);
	};

	let left = false;

	return {
		strategy,
		selfId,
		getPeerConnection: (peerId) => room.getPeers()[peerId],
		peers: () => Object.keys(room.getPeers()),

		onPeerJoin(cb) {
			joinCbs.add(cb);
			// Peers connect during the join confirmation window, before the
			// caller has a session to listen on, so registration replays the
			// peers already present. `getPeers()` is trystero's active-peer map
			// -- the same map it fires onPeerJoin from -- so this reports
			// exactly the joins that were missed, and never a peer that has not
			// connected. Callers must therefore tolerate `cb` firing
			// synchronously during registration.
			for (const peerId of Object.keys(room.getPeers())) cb(peerId);
		},

		onPeerLeave(cb) {
			leaveCbs.add(cb);
		},

		async leave() {
			// trystero deletes its room registration only after leave()'s
			// internal grace timer, and re-joining the same id before that
			// returns the stale room object. Guarding re-entry keeps that
			// window from being entered twice.
			if (left) return;
			left = true;
			joinCbs.clear();
			leaveCbs.clear();
			await room.leave();
		}
	};
}

/** Discards a room whose confirmation failed, so a dead attempt leaves nothing behind. */
async function abandon(room: Room): Promise<void> {
	try {
		await room.leave();
	} catch {
		// The attempt already failed; a failure to clean it up changes nothing
		// the caller can act on.
	}
}

const nostr: SignalingTransport = {
	name: 'nostr',
	// Public relays, no account, no quota. Always available, which is what
	// makes it the floor the ladder can always fall back to.
	isConfigured: () => true,

	async join(roomId, opts?: JoinOptions) {
		// The root export IS the nostr strategy in 0.25; there is no
		// 'trystero/nostr' that works.
		const { joinRoom, selfId, getRelaySockets } = await import('trystero');
		opts?.signal?.throwIfAborted();

		const room = joinRoom({ appId: APP_ID, rtcConfig: RTC_CONFIG }, roomId);
		try {
			await awaitOpenRelay(getRelaySockets as RelaySockets, 'nostr', opts?.signal);
		} catch (err) {
			await abandon(room);
			throw err;
		}
		return makeSession('nostr', selfId, room);
	}
};

const mqtt: SignalingTransport = {
	name: 'mqtt',
	isConfigured: () => true,

	async join(roomId, opts?: JoinOptions) {
		const { joinRoom, selfId, getRelaySockets } = await import('@trystero-p2p/mqtt');
		opts?.signal?.throwIfAborted();

		const room = joinRoom({ appId: APP_ID, rtcConfig: RTC_CONFIG }, roomId);
		try {
			await awaitOpenRelay(getRelaySockets as RelaySockets, 'mqtt', opts?.signal);
		} catch (err) {
			await abandon(room);
			throw err;
		}
		return makeSession('mqtt', selfId, room);
	}
};

export const transports: Record<StrategyName, SignalingTransport> = { nostr, mqtt };

/**
 * The configured strategies in the order they should be tried: `preferred`
 * first (the guest's link strategy, PLAN.md 4.6), then STRATEGY_ORDER.
 * Unconfigured strategies are absent rather than present-and-failing, so
 * skipping them costs no connect timeout.
 */
export function strategyLadder(preferred?: StrategyName): SignalingTransport[] {
	const order = preferred
		? [preferred, ...STRATEGY_ORDER.filter((n) => n !== preferred)]
		: [...STRATEGY_ORDER];
	return order.map((n) => transports[n]).filter((t) => t.isConfigured());
}
