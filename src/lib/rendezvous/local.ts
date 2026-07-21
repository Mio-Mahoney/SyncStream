/**
 * The localhost signaling strategy.
 *
 * This exists for the e2e suite (and local development): the public Nostr and
 * MQTT relays fail a few percent of connections, and playwright.config.ts runs
 * with `retries: 0`, so any one relay hiccup fails a whole run. PLAN.md 8 is
 * blunt that a flaky sync test is worse than no sync test. The fix is the seam
 * PLAN.md 4.6 built in advance: a `SignalingTransport` whose relay is a tiny
 * WebSocket server on this machine (tests/e2e/local-relay.ts), selected with
 * `?s=local` like any other strategy.
 *
 * What matters is how little this replaces. trystero's peer handshake -- offer
 * pool, SDP encryption, perfect-negotiation glue, announce cadence -- is the
 * production signaling path, and it is exercised unchanged: this file is a
 * `createTopicStrategy` adapter exactly like `@trystero-p2p/nostr`, swapping
 * only the bottom-most pub/sub layer for three JSON frames over one socket
 * (`sub`/`unsub`/`pub` up, `msg` down). Tests that pass here prove everything
 * but the public relay, which is the one part we cannot make deterministic.
 *
 * A separate strategy INSTANCE, not `relayConfig.urls` on the nostr strategy:
 * trystero runs a strategy module's `init(config)` exactly once, so whichever
 * join happens first would pin its relay list for the lifetime of the page.
 * Building on `@trystero-p2p/core` directly gives this strategy its own init,
 * its own relay manager and its own room registry, and leaves the public nostr
 * strategy exactly as deployed.
 *
 * The relay URL comes from `VITE_LOCAL_RELAY`, baked in at build time by the
 * e2e web server (see playwright.config.ts). A deploy build never sets it, so
 * in production this strategy is unconfigured, skipped by the ladder, and this
 * chunk is never even loaded.
 */

import {
	createRelayManager,
	createTopicStrategy,
	makeSocket,
	fromJson,
	toJson,
	type SocketClient,
	type StrategyMessage
} from '@trystero-p2p/core';

export { selfId } from '@trystero-p2p/core';

/** The three frames a client sends, and the one a relay does. */
type WireFrame =
	| { t: 'sub'; topic: string }
	| { t: 'unsub'; topic: string }
	| { t: 'pub'; topic: string; msg: string }
	| { t: 'msg'; topic: string; msg: string };

const relayManager = createRelayManager((client: SocketClient) => client.socket);

type TopicHandler = (topic: string, msg: string) => void;

/**
 * Live subscriptions per relay client, keyed by topic. One handler per topic
 * is enough: trystero subscribes each room's root and self topics exactly once,
 * and the room registry in core prevents a second join of the same room from
 * existing at all.
 */
const handlersByClient = new WeakMap<SocketClient, Record<string, TopicHandler>>();

const handlersFor = (client: SocketClient): Record<string, TopicHandler> => {
	let handlers = handlersByClient.get(client);
	if (!handlers) {
		handlers = {};
		handlersByClient.set(client, handlers);
	}
	return handlers;
};

/** The only frame a relay sends a client. */
type MsgFrame = Extract<WireFrame, { t: 'msg' }>;

const parseFrame = (data: string): MsgFrame | null => {
	let parsed: unknown;
	try {
		parsed = fromJson(data);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const f = parsed as Record<string, unknown>;
	if (f.t !== 'msg' || typeof f.topic !== 'string' || typeof f.msg !== 'string') return null;
	return { t: 'msg', topic: f.topic, msg: f.msg };
};

/**
 * The trystero entry point for the local strategy, shaped exactly like
 * `joinRoom` from `@trystero-p2p/nostr`. Requires `relayConfig.urls`: a local
 * strategy has no defaults worth shipping, and a caller without a relay URL has
 * no business here (`isConfigured` in trystero.ts is what keeps that true).
 */
export const joinLocalRoom = createTopicStrategy<SocketClient>({
	init: (config) => {
		const urls = config.relayConfig?.urls;
		if (!urls || urls.length === 0) {
			throw new Error('local rendezvous requires relayConfig.urls');
		}
		return urls.map((url) => {
			const client: SocketClient = relayManager.register(url, () =>
				makeSocket(
					url,
					(data) => {
						const frame = parseFrame(data);
						if (frame) handlersFor(client)[frame.topic]?.(frame.topic, frame.msg);
					},
					() => {
						// The socket reconnected, and the relay's subscription state
						// died with the old connection. Re-establish every live
						// subscription; anything published during the gap is gone,
						// exactly as it is on nostr (`since: now()`), and trystero's
						// re-announce cadence is what recovers from that.
						for (const topic of Object.keys(handlersFor(client))) {
							client.send(toJson({ t: 'sub', topic } satisfies WireFrame));
						}
					}
				)
			);
			return client.ready;
		});
	},

	subscribeTopic: (client, topic, onMessage) => {
		handlersFor(client)[topic] = (t, msg) => void onMessage(t, msg);
		client.send(toJson({ t: 'sub', topic } satisfies WireFrame));
		return () => {
			delete handlersFor(client)[topic];
			client.send(toJson({ t: 'unsub', topic } satisfies WireFrame));
		};
	},

	publishTopic: (client, topic, msg: StrategyMessage) => {
		client.send(
			toJson({
				t: 'pub',
				topic,
				msg: typeof msg === 'string' ? msg : toJson(msg)
			} satisfies WireFrame)
		);
	}
});

/** The same liveness window trystero.ts polls for the public strategies. */
export const getLocalRelaySockets = relayManager.getSockets;
