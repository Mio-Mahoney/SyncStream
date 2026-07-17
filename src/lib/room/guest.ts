/**
 * The guest half of a room.
 *
 * A guest pulls segments (from the host, or from another guest under Phase 5),
 * plays them through Shaka, and follows the host's clock. It sends intent and
 * status. It never sends state, and it never takes state from anyone but the
 * host.
 */

import {
	configurePlayer,
	createPlayer,
	currentRung,
	playerBufferAhead
} from '$lib/media/shaka/config';
import { registerSyncStreamScheme, unregisterSyncStreamScheme } from '$lib/media/shaka/scheme';
import { createMesh, type Mesh } from '$lib/mesh/mesh';
import type { ControlMessage, Track } from '$lib/protocol/control';
import { joinRoomByCode } from '$lib/rendezvous/room';
import type { StrategyName } from '$lib/rendezvous/transport';
import { createPeerNetwork, type PeerLink, type PeerNetwork } from '$lib/rtc/connection';
import { markFirstFrame, markTtffStart, removePeer, stats, updatePeer } from '$lib/stats.svelte';
import { ClockSync } from '$lib/sync/clock';
import { GuestSync } from '$lib/sync/state';
import type shaka from 'shaka-player/dist/shaka-player.compiled.js';

export type GuestRoom = {
	readonly player: shaka.Player | null;
	close(): void;
	sendIntent(action: 'play' | 'pause' | 'seek', mediaTime: number): void;
};

export type GuestRoomOptions = {
	video: HTMLMediaElement;
	code: string;
	name: string;
	preferred?: StrategyName;
	onReady: (duration: number) => void;
	/**
	 * The host has identified itself over the control channel. Rendezvous
	 * resolving only means *a* peer appeared, which under Phase 5 may be another
	 * guest, so this is the first moment the room is confirmed to exist. The gap
	 * between here and `onReady` is the host choosing a file, and it is
	 * unbounded - without this the guest cannot be told apart from one still
	 * searching, and reads "looking for the host" while sitting next to it.
	 */
	onHostFound: (name: string) => void;
	onUnplayable: (reason: string) => void;
	/**
	 * Who the room is being held for. `on` names the other guests; `you` says
	 * this guest is one of them, which is not derivable here - a guest is never
	 * told which display name is its own.
	 */
	onWaiting: (on: string[], you: boolean) => void;
	onError: (err: Error) => void;
	onHostGone: () => void;
	signal?: AbortSignal;
};

const STATUS_MS = 1000;

export async function startGuestRoom(opts: GuestRoomOptions): Promise<GuestRoom> {
	const session = await joinRoomByCode(opts.code, opts.preferred, { signal: opts.signal });

	stats.role = 'guest';
	stats.room = opts.code;
	stats.strategy = session.strategy;

	const net: PeerNetwork = createPeerNetwork([session]);

	/**
	 * The host peer, once it says so. Everything authoritative is gated on this
	 * identity: PLAN.md 4.9 says guests never command each other, and the only
	 * thing that makes that true is refusing to apply state from anyone else.
	 */
	let hostLink: PeerLink | null = null;
	let player: shaka.Player | null = null;
	let mesh: Mesh | null = null;
	let loaded = false;

	const clock = new ClockSync((msg) => hostLink?.channels.sendControl(msg));
	const sync = new GuestSync(opts.video, clock);

	/**
	 * A segReq or its segData/segErr reply going missing -- on a connection whose
	 * signaling rode a lossy public relay, or a peer whose channel died between
	 * the request and the reply -- otherwise hangs this fetch forever: nothing
	 * here times out on its own, and the host has no reason to resend something
	 * it already sent. That is invisible and unrecoverable for exactly the
	 * request that gates first frame, the init segment, since `player.load()`
	 * awaits it with no timeout of its own to fall back on. Matches
	 * mesh.ts's PEER_DEADLINE_MS: reject and let Shaka's own retry policy
	 * re-issue the request with a fresh reqId, which is a fresh chance for a
	 * one-off relay hiccup to not repeat.
	 */
	const HOST_FETCH_TIMEOUT_MS = 15_000;

	/** reqId -> resolver, for segments in flight to the host. */
	let nextReqId = 1;
	const pending = new Map<
		number,
		{ resolve: (b: Uint8Array) => void; reject: (e: Error) => void; cleanup: () => void }
	>();

	const fetchFromHost = (repId: number, track: Track, segIdx: number, signal: AbortSignal) =>
		new Promise<Uint8Array>((resolve, reject) => {
			const link = hostLink;
			if (!link) return reject(new Error('guest: no host connected'));

			const reqId = nextReqId++;
			const finish = (err: () => Error) => {
				const p = pending.get(reqId);
				if (!p) return;
				pending.delete(reqId);
				// Both halves matter: the host stops producing, and we stop
				// holding the partial reassembly it already sent. Without the
				// second, a seek leaks every segment it abandoned.
				link.channels.sendControl({ t: 'segCancel', reqId });
				link.channels.cancelInbound(reqId);
				reject(err());
			};
			const onAbort = () => finish(() => new DOMException('segment request aborted', 'AbortError'));
			signal.addEventListener('abort', onAbort, { once: true });

			const timer = setTimeout(
				() =>
					finish(
						() =>
							new Error(
								`guest: no reply from host for segment ${repId}/${track}/${segIdx} within ${HOST_FETCH_TIMEOUT_MS}ms`
							)
					),
				HOST_FETCH_TIMEOUT_MS
			);

			pending.set(reqId, {
				resolve,
				reject,
				cleanup: () => {
					signal.removeEventListener('abort', onAbort);
					clearTimeout(timer);
				}
			});
			link.channels.sendControl({ t: 'segReq', reqId, repId, track, segIdx });
		});

	const settle = (reqId: number, fn: (p: NonNullable<ReturnType<typeof pending.get>>) => void) => {
		const p = pending.get(reqId);
		if (!p) return;
		pending.delete(reqId);
		p.cleanup();
		fn(p);
	};

	const startPlayback = async (mpd: string, duration: number) => {
		if (loaded) return;
		loaded = true;
		markTtffStart();

		player = await createPlayer(opts.video);
		player.addEventListener('error', (e) =>
			opts.onError(
				new Error(
					`playback: ${(e as unknown as { detail?: { message?: string } }).detail?.message ?? 'shaka error'}`
				)
			)
		);

		// PLAN.md 4.2: the scheme handler is a URI parser and a promise. Under
		// Phase 5 the promise happens to prefer a peer, which Shaka neither
		// knows nor cares about.
		registerSyncStreamScheme(mesh!.fetch);

		// ChannelStats.throughputBps is BYTES/sec; Shaka's
		// abr.defaultBandwidthEstimate is BITS/sec. Seeding it with the wrong
		// unit would tell Shaka the link is 8x slower than it is and pin every
		// guest to the bottom rung.
		const measuredBps = (hostLink?.channels.stats.throughputBps ?? 0) * 8;
		configurePlayer(player, measuredBps > 0 ? { bandwidthEstimate: measuredBps } : {});

		const blob = URL.createObjectURL(new Blob([mpd], { type: 'application/dash+xml' }));
		try {
			await player.load(blob);
		} finally {
			URL.revokeObjectURL(blob);
		}

		// Restrictions only bite once variants exist, which is after load().
		// Applying them before is a silent no-op, and a silent no-op here means
		// Shaka can pick a rung the host has not encoded yet.
		configurePlayer(player, { availableRungs: stats.availableRungs });

		opts.video.addEventListener('loadeddata', () => markFirstFrame(), { once: true });
		clock.start();
		sync.start();
		opts.onReady(duration);
	};

	const onControl = (link: PeerLink, msg: ControlMessage) => {
		// Anything below this line is authoritative, so it must come from the
		// host and nobody else.
		const fromHost = hostLink !== null && link.peerId === hostLink.peerId;

		switch (msg.t) {
			case 'hello':
				updatePeer(link.peerId, { name: msg.name, role: msg.role });
				if (msg.role === 'host') {
					hostLink = link;
					stats.candidateType = link.candidateType;
					mesh = createMesh({ network: net, hostPeerId: link.peerId, fetchFromHost });
					opts.onHostFound(msg.name);
				}
				break;

			case 'ready':
				if (fromHost) void startPlayback(msg.mpd, msg.duration);
				break;

			case 'unplayable':
				if (fromHost) opts.onUnplayable(msg.reason);
				break;

			case 'state':
				if (fromHost) sync.apply(msg);
				break;

			case 'rungs':
				if (!fromHost) break;
				stats.availableRungs = msg.available;
				if (player && loaded) configurePlayer(player, { availableRungs: msg.available });
				break;

			case 'waiting':
				if (fromHost) opts.onWaiting(msg.on, msg.you === true);
				break;

			case 'pong':
				if (fromHost) clock.onPong(msg);
				break;

			case 'segErr':
				settle(msg.reqId, (p) => {
					link.channels.cancelInbound(msg.reqId);
					p.reject(new Error(msg.reason));
				});
				break;

			case 'sourcesRes':
			case 'have':
				// Guest-to-guest mesh traffic. mesh.ts owns the bookkeeping; a
				// guest is a tracker for nobody, so `have` is ignored here.
				break;

			case 'segReq': {
				// Another guest pulling from our cache (PLAN.md Phase 5). Serving
				// is the same code path as the host's, minus the origin.
				const bytes = mesh?.serve(link.peerId, msg.repId, msg.track, msg.segIdx) ?? null;
				if (bytes) void link.channels.sendSegment(msg.reqId, bytes);
				else
					link.channels.sendControl({
						t: 'segErr',
						reqId: msg.reqId,
						reason: 'not cached here'
					});
				break;
			}

			default:
				break;
		}
	};

	net.onPeer((link) => {
		updatePeer(link.peerId, { candidateType: link.candidateType });
		link.channels.onControl((msg) => onControl(link, msg));
		link.channels.onSegment((reqId, payload) => settle(reqId, (p) => p.resolve(payload)));
		link.channels.sendControl({ t: 'hello', role: 'guest', name: opts.name });
	});

	net.onPeerGone((peerId) => {
		removePeer(peerId);
		if (hostLink?.peerId === peerId) {
			// PLAN.md Phase 1: the room exists while the host is connected.
			hostLink = null;
			opts.onHostGone();
		}
	});

	net.onError((err) => opts.onError(err));

	const statusTimer = setInterval(() => {
		if (!hostLink || !player) return;
		const bufferedAhead = playerBufferAhead(player, opts.video);
		const rung = currentRung(player);
		stats.bufferedAhead = bufferedAhead;
		stats.rung = rung;
		stats.rtt = clock.rtt;
		stats.clockOffset = clock.offset;
		stats.drift = sync.drift;
		stats.throughputBps = hostLink.channels.stats.throughputBps;
		stats.iceState = hostLink.pc.iceConnectionState;
		stats.candidateType = hostLink.candidateType;
		hostLink.channels.sendControl({
			t: 'status',
			bufferedAhead,
			rung,
			throughput: hostLink.channels.stats.throughputBps,
			name: opts.name
		});
		mesh?.announce();
	}, STATUS_MS);

	return {
		get player() {
			return player;
		},
		sendIntent: (action, mediaTime) =>
			hostLink?.channels.sendControl({ t: 'intent', action, mediaTime }),
		close: () => {
			clearInterval(statusTimer);
			sync.stop();
			clock.stop();
			unregisterSyncStreamScheme();
			mesh?.close();
			void player?.destroy();
			net.close();
			void session.leave();
			for (const [, p] of pending) p.reject(new Error('room closed'));
			pending.clear();
		}
	};
}
