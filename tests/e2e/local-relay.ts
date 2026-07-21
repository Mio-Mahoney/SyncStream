/**
 * The localhost signaling relay the e2e suite runs against.
 *
 * Started by playwright.config.ts as a second webServer; the app build bakes
 * its URL in as VITE_LOCAL_RELAY, and `?s=local` is what points a page at it
 * (see src/lib/rendezvous/local.ts for the whole argument). It is a plain
 * topic pub/sub: `sub`/`unsub`/`pub` frames in, `msg` frames out, JSON all the
 * way. Everything above this -- offers, answers, announce cadence -- is
 * trystero's production signaling, unchanged.
 *
 * Runs under `bun` on Bun.serve's built-in websocket topics, deliberately
 * dependency-free: static.spec.ts asserts the `ws` package stays out of the
 * manifest, because a websocket server dependency is the shape of the old
 * pre-PLAN design. This file is test scaffolding on the runtime the repo
 * already uses, not a server dependency creeping back in.
 *
 * Live delivery only, NO replay of history -- because that is what the
 * production strategies give trystero: the nostr strategy subscribes with
 * `since: now()`, so a late subscriber sees nothing that happened before it
 * arrived and catches up off the 5.3s re-announce cadence instead. An earlier
 * version of this relay replayed a 30s window "to be safe", and the backlog
 * of stale announces it burst at late joiners was pure deviation from what
 * production delivers. The race replay might have covered is closed by
 * ordering instead: a client's subscribes are processed before anything it
 * later publishes (one FIFO socket to one relay), so by the time any peer can
 * react to an announce, the announcer's own subscriptions are registered.
 * Supabase Broadcast could not make that promise, which is why it died (see
 * STRATEGY_ORDER in src/lib/rendezvous/transport.ts); a single local relay
 * can.
 *
 * Delivery includes the publisher when it subscribes to the topic
 * (server.publish, not ws.publish), exactly like a public relay: trystero
 * filters self-messages by peerId, and a relay that pre-filtered them would
 * be exercising a politer protocol than the one production runs on.
 */

import { LOCAL_RELAY_PORT } from './base';

type ClientFrame =
	| { t: 'sub'; topic: string }
	| { t: 'unsub'; topic: string }
	| { t: 'pub'; topic: string; msg: string };

const parseFrame = (raw: string | Buffer): ClientFrame | null => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(raw));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const f = parsed as Record<string, unknown>;
	if (typeof f.topic !== 'string') return null;
	if (f.t === 'sub' || f.t === 'unsub') return { t: f.t, topic: f.topic };
	if (f.t === 'pub' && typeof f.msg === 'string') return { t: 'pub', topic: f.topic, msg: f.msg };
	return null;
};

const server = Bun.serve({
	port: LOCAL_RELAY_PORT,
	fetch(req, srv) {
		if (srv.upgrade(req)) return undefined;
		return new Response('SyncStream local signaling relay: connect over WebSocket', {
			status: 426
		});
	},
	websocket: {
		message(ws, raw) {
			const frame = parseFrame(raw);
			if (!frame) return;
			switch (frame.t) {
				case 'sub':
					ws.subscribe(frame.topic);
					break;
				case 'unsub':
					ws.unsubscribe(frame.topic);
					break;
				case 'pub':
					server.publish(
						frame.topic,
						JSON.stringify({ t: 'msg', topic: frame.topic, msg: frame.msg })
					);
					break;
			}
		}
		// No close handler: Bun drops a socket's subscriptions with the socket.
	}
});

console.log(`local signaling relay listening on ws://localhost:${server.port}`);
