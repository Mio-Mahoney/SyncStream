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
	/**
	 * Say who we are. `name` was only ever a fallback ("Guest 412"), and the room
	 * is where it gets replaced: the invite link puts us in the room before we
	 * have been asked anything, so naming ourselves has to be something we can do
	 * from inside it (see identity.ts).
	 */
	setName(name: string): void;
};

export type GuestRoomOptions = {
	video: HTMLMediaElement;
	code: string;
	/** What to call ourselves until `setName` says otherwise. */
	name: string;
	preferred?: StrategyName;
	/**
	 * The film is loaded and playing. `title` is what it is called, which only the
	 * host can say - the file is on its disk and nowhere else.
	 */
	onReady: (film: { duration: number; title: string }) => void;
	/**
	 * What the host is called, and the first proof it is there at all.
	 *
	 * Rendezvous resolving only means *a* peer appeared, which under Phase 5 may
	 * be another guest, so the host's hello is the first moment the room is
	 * confirmed to exist. The gap between here and `onReady` is the host choosing
	 * a file, and it is unbounded - without this the guest cannot be told apart
	 * from one still searching, and reads "looking for the host" while sitting
	 * next to it.
	 *
	 * Fires again if the host renames itself, since the name on that first hello
	 * is a fallback the machine invented and this is the only thing carrying the
	 * host's real one to a guest with no film yet.
	 */
	onHostName: (name: string) => void;
	/**
	 * Who this guest is watching with: the host, then every other guest, as the
	 * host states it and never including us.
	 *
	 * The host's counterpart of this fact has had a screen of its own since the
	 * invite panel ("Guest 412 is here" - the proof their link worked). A guest
	 * was never told any of it: with the film up, their entire page was the room
	 * code and a clock, so the people they came to watch with were unaccounted
	 * for on the one screen that IS the watch party.
	 *
	 * Comes off the wire rather than from our own peers, and must: the mesh links
	 * guests opportunistically, so our peer list is who we happen to be meshed
	 * with, which is a permanent undercount of the room (see `Roster` in
	 * protocol/control).
	 *
	 * `host` and `guests` stay apart because the screens that read this ask
	 * different questions of it: under the player it is one room ("Watching with
	 * Alice and Bob"), while the waiting room has already named the host on the
	 * line above and is asking who *else* turned up.
	 */
	onCompany: (room: { host: string; guests: string[] }) => void;
	onUnplayable: (reason: string) => void;
	/**
	 * Who the room is being held for. `on` names the other guests; `you` says
	 * this guest is one of them, which is not derivable here - a guest is never
	 * told which display name is its own.
	 */
	onWaiting: (on: string[], you: boolean) => void;
	/**
	 * Who stopped the film, by name, and whether that was us - `you` for the same
	 * reason `onWaiting` carries it. Null once nothing deliberate is holding it.
	 */
	onPaused: (by: string | null, you: boolean) => void;
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
	/**
	 * Mutable, and read at send time: the hello of any peer we meet after we have
	 * named ourselves must carry the name we chose, not the one we arrived under.
	 */
	let name = opts.name;
	let player: shaka.Player | null = null;
	let mesh: Mesh | null = null;
	/**
	 * The manifest of the film in play, or null when there is none.
	 *
	 * Identity rather than a boolean, because both questions matter and they have
	 * different answers: the host re-sends `ready` for the film already playing
	 * (once from `onPeer`, once from the hello it answers), and a repeat of that
	 * must not restart anything - while a genuinely different film must.
	 */
	let loadedMpd: string | null = null;

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

	/**
	 * Take down the film that is playing, leaving the room itself alone.
	 *
	 * The host may put on a second film without ending the room, and everything
	 * `startPlayback` built is about the first one: a Shaka player holding a
	 * source buffer full of it, segment requests in flight for it, and a mesh
	 * cache keyed by repId/track/segIdx - keys the next film reuses for entirely
	 * different bytes. Keeping that cache would have us serve another guest the
	 * old film's segment 3 under the new film's name, and mesh.ts is explicit
	 * that it cannot tell: "the key is content-addressing by convention, not by
	 * digest". So the cache goes with the film, which a fresh mesh is the honest
	 * way to get. `net.onPeer` replays the links we already have, so rebuilding
	 * it re-wires the room rather than dropping it.
	 */
	const stopPlayback = async () => {
		if (loadedMpd === null) return;
		loadedMpd = null;
		sync.stop();
		opts.video.pause();

		// Before the mesh goes, so Shaka's own aborts settle their requests
		// through the transport that issued them.
		const old = player;
		player = null;
		await old?.destroy();

		for (const reqId of [...pending.keys()])
			settle(reqId, (p) => p.reject(new Error('guest: the host changed the video')));

		mesh?.close();
		mesh = hostLink
			? createMesh({ network: net, hostPeerId: hostLink.peerId, fetchFromHost })
			: null;
	};

	const startPlayback = async (mpd: string, duration: number, title: string) => {
		if (loadedMpd === mpd) return;
		await stopPlayback();

		// `stopPlayback` rebuilds the mesh around the host, and leaves it null when
		// there is no longer a host to build it around - it tears the old player
		// down first, and a host who closes their tab during a film change is gone
		// by the time it reads the link. There is no film to start without one, and
		// asserting the mesh here instead threw a TypeError out through
		// `queuePlayback`'s catch into `onError`, which outranks `roomOver` on the
		// page: the guest lost the screen that says the party is over, and the way
		// home on it, and read a raw JS error in its place. Leaving is not an error.
		if (!mesh) return;

		loadedMpd = mpd;
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
		registerSyncStreamScheme(mesh.fetch);

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
		opts.onReady({ duration, title });
	};

	/**
	 * One film at a time, in the order the host announced them. `ready` arrives
	 * from an event handler that cannot await, so two of them in quick succession
	 * would otherwise have a teardown running against a `player.load()` that is
	 * still building the thing being torn down.
	 */
	let playback: Promise<void> = Promise.resolve();
	const queuePlayback = (mpd: string, duration: number, title: string) => {
		playback = playback
			.then(() => startPlayback(mpd, duration, title))
			.catch((err: Error) => opts.onError(err));
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
					opts.onHostName(msg.name);
				}
				break;

			// Only the host's own name is ours to render. Another guest's reaches us
			// through the host's roster, which is the only complete view of the room
			// (see `Roster` in protocol/control) - taking it from the peer directly
			// would name whoever the mesh happened to link us to and silently omit
			// the rest.
			case 'rename':
				updatePeer(link.peerId, { name: msg.name });
				if (fromHost) opts.onHostName(msg.name);
				break;

			case 'ready':
				if (fromHost) queuePlayback(msg.mpd, msg.duration, msg.title);
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
				if (player && loadedMpd) configurePlayer(player, { availableRungs: msg.available });
				break;

			case 'waiting':
				if (fromHost) opts.onWaiting(msg.on, msg.you === true);
				break;

			case 'roster':
				if (fromHost) opts.onCompany({ host: msg.host, guests: msg.guests });
				break;

			case 'paused':
				if (fromHost) opts.onPaused(msg.by ?? null, msg.you === true);
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
		link.channels.sendControl({ t: 'hello', role: 'guest', name });
	});

	net.onPeerGone((peerId) => {
		removePeer(peerId);
		if (hostLink?.peerId === peerId) {
			// PLAN.md Phase 1: the room exists while the host is connected.
			hostLink = null;
			// Nothing steers this element any more, so stop steering it. GuestSync
			// re-asserts the host's last state every tick by design - that is what
			// recovers a play() the autoplay policy refused - but with no host left
			// to update that state, it re-asserted `playing` forever, and would undo
			// any pause from above within a tick. The guest buffers ~12s ahead
			// (ladder.ts LOOKAHEAD_SEGMENTS), so the film played on, audible and
			// invisible, behind a page saying the party was over and that there was
			// nothing left to play.
			sync.stop();
			opts.video.pause();
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
		stats.mesh = mesh ? mesh.stats : null;
		hostLink.channels.sendControl({
			t: 'status',
			bufferedAhead,
			rung,
			throughput: hostLink.channels.stats.throughputBps,
			name
		});
		mesh?.announce();
	}, STATUS_MS);

	return {
		get player() {
			return player;
		},
		sendIntent: (action, mediaTime) =>
			hostLink?.channels.sendControl({ t: 'intent', action, mediaTime }),
		/**
		 * To the host alone, who holds every name in the room and re-states the
		 * roster from there. Telling the other guests ourselves would race that,
		 * and would only reach the ones the mesh happened to link us to.
		 */
		setName: (n: string) => {
			name = n;
			hostLink?.channels.sendControl({ t: 'rename', name: n });
		},
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
