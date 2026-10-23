/**
 * The guest half of a room.
 *
 * A guest pulls segments (from the host, or from another guest under Phase 5),
 * plays them through Shaka, and follows the host's clock. It sends intent and
 * status. It never sends state, and it never takes state from anyone but the
 * host.
 */

import {
	bandwidthEstimate,
	configurePlayer,
	createPlayer,
	currentRung,
	describePlaybackError,
	playerAtEnd,
	playerBufferAhead
} from '$lib/media/shaka/config';
import { registerSyncStreamScheme, unregisterSyncStreamScheme } from '$lib/media/shaka/scheme';
import { fallbackName, remoteName } from '$lib/identity';
import { createMesh, type Mesh } from '$lib/mesh/mesh';
import { isFault, type ControlMessage, type Fault, type Track } from '$lib/protocol/control';
import { joinRoomByCode, UnreachableError } from '$lib/rendezvous/room';
import type { StrategyName } from '$lib/rendezvous/transport';
import { createPeerNetwork, type PeerLink, type PeerNetwork } from '$lib/rtc/connection';
import {
	markFirstFrame,
	markTtffStart,
	noteStall,
	removePeer,
	stats,
	updatePeer
} from '$lib/stats.svelte';
import { ClockSync } from '$lib/sync/clock';
import { BARRIER_LOW_SEC, GuestSync } from '$lib/sync/state';
import type shaka from 'shaka-player/dist/shaka-player.compiled.js';

export type GuestRoom = {
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
	/** The room's key, off the invite link (codes.ts). */
	secret: string;
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
	onUnplayable: (fault: Fault) => void;
	/**
	 * The host tried to put on another film and could not; the one playing
	 * stays on. Rendered beside it, never in place of it.
	 */
	onSwitchFailed: (title: string, fault: Fault) => void;
	/**
	 * Rendezvous found people in the room, and none of them is the host, for
	 * long enough that it is not just slow. The host closed its tab after a
	 * guest stayed, most likely. The search carries on; this is so the screen
	 * can say what it is waiting for instead of spinning on "looking for the
	 * room" indefinitely.
	 */
	onNoHost: () => void;
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

/**
 * How long after rendezvous to wait for a host's hello before saying so.
 * Rendezvous resolves on *a* peer, which under Phase 5 may be another guest;
 * a host that is there says hello within a round trip of the link opening.
 */
export const HOST_HELLO_MS = 10_000;

export async function startGuestRoom(opts: GuestRoomOptions): Promise<GuestRoom> {
	stats.role = 'guest';
	stats.room = opts.code;
	const session = await joinRoomByCode(opts.code, opts.secret, opts.preferred, {
		signal: opts.signal
	}).catch((err: unknown) => {
		// The PLAN.md 9 measurement, from the side that has no candidate type to
		// record: with no TURN configured, a connection that needed a relay is
		// one that never opened (see stats.svelte.ts). Only an *observed* ICE
		// failure counts; a deadline that ran out says nothing about why.
		if (err instanceof UnreachableError && err.cause === 'ice-failed') stats.iceState = 'failed';
		throw err;
	});
	stats.strategy = session.strategy;

	const net: PeerNetwork = createPeerNetwork([session]);

	/**
	 * The host peer, once it says so. Everything authoritative is gated on this
	 * identity: PLAN.md 4.9 says guests never command each other, and the only
	 * thing that makes that true is refusing to apply state from anyone else.
	 */
	let hostLink: PeerLink | null = null;
	/**
	 * Every connected peer that has said it is the host, oldest claim first.
	 *
	 * The room code is the only credential there is (PLAN.md 4.7), so a claim
	 * cannot be checked - but it can be ordered. The first claimant is the host
	 * for as long as it stays connected, and a later one is remembered rather
	 * than obeyed: a second host probing a code that turned out to be taken says
	 * hello as a host to everyone in the room before it backs off, and letting
	 * that hello take over would hand the room to a peer that leaves a second
	 * later, ending the party for a guest whose real host never went anywhere.
	 * The claim is kept because the other way a second host appears is a real
	 * one - the host reloaded, and the old page has not timed out yet.
	 */
	const hostClaims = new Map<string, { link: PeerLink; name: string }>();
	/** The last host we followed, to tell that host coming back from a new one. */
	let lastHostId: string | null = null;
	/**
	 * Mutable, and read at send time: the hello of any peer we meet after we have
	 * named ourselves must carry the name we chose, not the one we arrived under.
	 */
	let name = opts.name;
	let player: shaka.Player | null = null;
	let mesh: Mesh | null = null;
	/** `close()` has run. Checked after every await that could outlive it. */
	let closed = false;
	/**
	 * The host's latest `meshPlan`, kept outside the mesh because the mesh does
	 * not outlive the film (stopPlayback rebuilds it) while the stripe is about
	 * the room's membership and does. Re-applied to every mesh built here.
	 */
	let meshPlan: { slot: number; of: number; rungs: number[] } | null = null;
	/**
	 * The id of the film in play (`Ready.film`), or null when there is none.
	 *
	 * Identity rather than a boolean, because both questions matter and they have
	 * different answers: the host re-sends `ready` for the film already playing
	 * (once from `onPeer`, once from the hello it answers), and a repeat of that
	 * must not restart anything - while a genuinely different film must. The id
	 * and not the manifest text: a renamed copy of the same file emits the same
	 * manifest, and used to be taken for a repeat.
	 */
	let loadedFilmId: string | null = null;
	/**
	 * A film this player refused (`cannotPlay` was sent for it). The status tick
	 * stays quiet for it, and a later `ready` for the same id is not retried:
	 * the browser's answer does not change until the film does.
	 */
	let refusedFilmId: string | null = null;
	/** What `onReady` said about that film, to say again if its host comes back. */
	let loadedFilm: { duration: number; title: string } | null = null;

	/**
	 * Names off the wire, through the gate the host's go through (identity.ts
	 * `remoteName`): a junk name keeps whatever the peer was called, and a
	 * peer whose first word is junk still gets one.
	 */
	const nameFrom = (peerId: string, raw: unknown, role: 'host' | 'guest'): string => {
		const known = stats.peers.find((p) => p.peerId === peerId)?.name;
		// `updatePeer` seeds a peer's name with its id, which is not a name.
		const prev = known && known !== peerId ? known : '';
		return remoteName(raw, prev || fallbackName(role));
	};

	const clock = new ClockSync((msg) => hostLink?.channels.sendControl(msg));
	const sync = new GuestSync(opts.video, clock);

	/**
	 * A segReq or its segData/segErr reply going missing -- on a connection whose
	 * signaling rode a lossy public relay, or a peer whose channel died between
	 * the request and the reply -- otherwise hangs this fetch forever: nothing
	 * here times out on its own, and the host has no reason to resend something
	 * it already sent. That is invisible and unrecoverable for exactly the
	 * request that gates first frame, the init segment, since `player.load()`
	 * awaits it with no timeout of its own to fall back on. Reject and let
	 * Shaka's own retry policy re-issue the request with a fresh reqId, which is
	 * a fresh chance for a one-off relay hiccup to not repeat.
	 *
	 * Liveness by observed progress, not a flat deadline -- the same reasoning
	 * as mesh.ts's sweep(), and measured, not theoretical: under the Phase 5
	 * criterion's 12 Mbps uplink, four guests' live and prefetch traffic share
	 * one token bucket, and a ~5MB native segment legitimately trickles for
	 * 20-30s. A flat 15s timer killed every such transfer a few seconds short
	 * of done, so the uplink burned on bytes that were then thrown away, live
	 * traffic starved behind the doomed transfers, and the readiness barrier
	 * ground the room to a halt. Progress on the host link (an ordered channel:
	 * movement on any request proves the queue is moving) resets the stall
	 * clock; the hard deadline still bounds the truly-lost case.
	 */
	const HOST_FETCH_STALL_MS = 15_000;
	const HOST_FETCH_DEADLINE_MS = 60_000;
	const HOST_FETCH_SWEEP_MS = 500;

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
			const filmId = loadedFilmId ?? '';
			const finish = (err: () => Error) => {
				const p = pending.get(reqId);
				if (!p) return;
				pending.delete(reqId);
				stats.segmentQueue = pending.size;
				// The watchdog is an interval, not the old one-shot: left armed it
				// would sweep a request that no longer exists, forever.
				p.cleanup();
				// Both halves matter: the host stops producing, and we stop
				// holding the partial reassembly it already sent. Without the
				// second, a seek leaks every segment it abandoned.
				link.channels.sendControl({ t: 'segCancel', reqId });
				link.channels.cancelInbound(reqId);
				reject(err());
			};
			const onAbort = () => finish(() => new DOMException('segment request aborted', 'AbortError'));
			signal.addEventListener('abort', onAbort, { once: true });

			const startedAt = performance.now();
			let lastBytes = link.channels.stats.bytesRecv;
			let lastProgressAt = startedAt;
			const timer = setInterval(() => {
				const now = performance.now();
				const recv = link.channels.stats.bytesRecv;
				if (recv > lastBytes) {
					lastBytes = recv;
					lastProgressAt = now;
				}
				if (now - startedAt >= HOST_FETCH_DEADLINE_MS) {
					finish(
						() =>
							new Error(
								`guest: segment ${repId}/${track}/${segIdx} not complete after ${HOST_FETCH_DEADLINE_MS}ms`
							)
					);
				} else if (now - lastProgressAt >= HOST_FETCH_STALL_MS) {
					finish(
						() =>
							new Error(
								`guest: nothing from the host for ${HOST_FETCH_STALL_MS}ms on segment ${repId}/${track}/${segIdx}`
							)
					);
				}
			}, HOST_FETCH_SWEEP_MS);

			pending.set(reqId, {
				resolve,
				reject,
				cleanup: () => {
					signal.removeEventListener('abort', onAbort);
					clearInterval(timer);
				}
			});
			stats.segmentQueue = pending.size;
			// Admit the reply before asking for it (channel.ts expectInbound).
			link.channels.expectInbound(reqId);
			link.channels.sendControl({ t: 'segReq', reqId, repId, track, segIdx, film: filmId });
		});

	const settle = (reqId: number, fn: (p: NonNullable<ReturnType<typeof pending.get>>) => void) => {
		const p = pending.get(reqId);
		if (!p) return;
		pending.delete(reqId);
		stats.segmentQueue = pending.size;
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
		if (loadedFilmId === null) return;
		loadedFilmId = null;
		loadedFilm = null;
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
		mesh = null;
	};

	/** A mesh for `filmId`, around the host we have. Null with no host to build it around. */
	const buildMesh = (filmId: string): Mesh | null => {
		if (!hostLink) return null;
		const m = createMesh({
			network: net,
			hostPeerId: hostLink.peerId,
			fetchFromHost,
			film: filmId
		});
		if (meshPlan) m.setPlan(meshPlan.slot, meshPlan.of, meshPlan.rungs);
		return m;
	};

	const startPlayback = async (
		filmId: string,
		mpd: string,
		duration: number,
		title: string,
		/** When the host's `ready` arrived, so the queue's share of first frame is measured. */
		readyAt: number
	) => {
		if (loadedFilmId === filmId || refusedFilmId === filmId) return;
		await stopPlayback();
		if (closed) return;

		// `stopPlayback` tore the old player down first, and a host who closes
		// their tab during a film change is gone by the time it reads the link.
		// There is no film to start without one, and asserting the mesh here
		// instead threw a TypeError out through `queuePlayback`'s catch into
		// `onError`, which outranks `roomOver` on the page: the guest lost the
		// screen that says the party is over, and the way home on it, and read
		// a raw JS error in its place. Leaving is not an error.
		mesh = buildMesh(filmId);
		if (!mesh) return;

		loadedFilmId = filmId;
		refusedFilmId = null;
		mesh.noteDuration(duration);
		markTtffStart();
		stats.timings.readyToLoadMs = Math.round(performance.now() - readyAt);

		/**
		 * This browser cannot play the film: said to the host, which lets the
		 * barrier go of us and names the real cause, and thrown here as the thing
		 * the viewer can act on, which for a codec is usually "another browser".
		 * Both the player's construction (Shaka refuses a browser whose MSE
		 * accepts no codec at all) and its load (no playable variant) land here.
		 */
		const refuse = async (err: unknown): Promise<never> => {
			const fault: Fault = {
				code: 'unsupported-here',
				detail: describePlaybackError(err),
				remedy:
					'Try a different browser on this device - a current Chrome or Edge plays the most formats.'
			};
			refusedFilmId = filmId;
			// Nothing of this film stays up: the player (so the status tick falls
			// silent - a player with no film reported an empty buffer every second,
			// which is the stall the barrier then held the room for), the mesh built
			// around it, and the scheme handler pointing at that mesh.
			loadedFilmId = null;
			const failed = player;
			player = null;
			unregisterSyncStreamScheme();
			mesh?.close();
			mesh = null;
			await failed?.destroy().catch(() => {});
			hostLink?.channels.sendControl({ t: 'cannotPlay', film: filmId, fault });
			throw Object.assign(new Error(fault.detail), { fault });
		};

		try {
			player = await createPlayer(opts.video);
		} catch (err) {
			await refuse(err);
		}
		if (!player) return;
		if (closed || loadedFilmId !== filmId) {
			await player.destroy();
			player = null;
			return;
		}
		player.addEventListener('error', (e) =>
			opts.onError(new Error(describePlaybackError((e as unknown as { detail?: unknown }).detail)))
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
		// The rung window goes on before load, read off the manifest itself: the
		// first variant Shaka picks is chosen during load, and that is the pick a
		// guest without the native codec most needs steered (rungs.ts).
		configurePlayer(player, {
			...(measuredBps > 0 ? { bandwidthEstimate: measuredBps } : {}),
			availableRungs: stats.availableRungs,
			mpd
		});

		// Where the host is, so the first segments fetched are the ones that will
		// be watched. Without this the player buffered position 0, marked a
		// first frame nobody saw, and then hard-seeked to the host's position and
		// did it all again - two seconds of join latency spent on the wrong part
		// of the film, and a TTFF measured on it.
		const start = startPosition();

		const blob = URL.createObjectURL(new Blob([mpd], { type: 'application/dash+xml' }));
		const loadStarted = performance.now();
		try {
			await player.load(blob, start);
		} catch (err) {
			await refuse(err);
		} finally {
			URL.revokeObjectURL(blob);
		}
		stats.timings.loadMs = Math.round(performance.now() - loadStarted);
		if (closed || loadedFilmId !== filmId) return;

		// Restrictions re-applied against the loaded variants: the manifest read
		// above predicted them, and the loaded list is the truth.
		configurePlayer(player, { availableRungs: stats.availableRungs });

		// A painted frame, where the browser can say so, rather than
		// `loadeddata` (which fires on HAVE_CURRENT_DATA, before any paint).
		markOnFirstPaint(opts.video);
		opts.video.addEventListener('waiting', onStall);
		clock.start();
		sync.start();
		loadedFilm = { duration, title };
		opts.onReady(loadedFilm);
	};

	/**
	 * The host's position as a load-time start, in the stream's seconds. Null
	 * when nothing is known yet (the host's `state` has not arrived), which is
	 * Shaka's own default. A paused host is at its mediaTime; a playing one has
	 * moved on since the message, by the clock if it is measured and by nothing
	 * otherwise - the sync engine corrects the rest once it runs.
	 */
	const startPosition = (): number | undefined => {
		const s = sync.lastState;
		if (!s) return undefined;
		const elapsedSec =
			s.playing && clock.samples > 0 ? (clock.hostNow() - s.atHostClock) / 1000 : 0;
		const t = s.mediaTime + Math.max(0, elapsedSec);
		return Number.isFinite(t) && t > 0 ? t : undefined;
	};

	/** A stall the viewer saw: the element ran out of data mid-play. */
	const onStall = () => {
		if (!opts.video.seeking) noteStall();
	};

	const markOnFirstPaint = (video: HTMLMediaElement): void => {
		const v = video as HTMLVideoElement & {
			requestVideoFrameCallback?: (cb: () => void) => number;
		};
		if (typeof v.requestVideoFrameCallback === 'function') {
			v.requestVideoFrameCallback(() => markFirstFrame());
		} else {
			video.addEventListener('loadeddata', () => markFirstFrame(), { once: true });
		}
	};

	/**
	 * One film at a time, in the order the host announced them. `ready` arrives
	 * from an event handler that cannot await, so two of them in quick succession
	 * would otherwise have a teardown running against a `player.load()` that is
	 * still building the thing being torn down.
	 */
	let playback: Promise<void> = Promise.resolve();
	const queuePlayback = (filmId: string, mpd: string, duration: number, title: string) => {
		const readyAt = performance.now();
		playback = playback
			.then(() => startPlayback(filmId, mpd, duration, title, readyAt))
			.catch((err: Error) => {
				if (!closed) opts.onError(err);
			});
	};

	/**
	 * Peers whose hello has reached us, so the reply below happens once per
	 * link. Cleared when the peer goes, because a peer that reconnects is a
	 * fresh link doing the handshake over.
	 */
	const helloSeen = new Set<string>();

	/**
	 * Start following `link` as the host. Only ever called with no host live.
	 *
	 * Everything the sync engine holds is about one host page, and none of it
	 * survives a change of page: `seq` restarts at 1 there, so the last state we
	 * applied would outrank every new one for as many seconds as the old host
	 * ran, and the clock offset was measured against a clock that no longer
	 * exists. Both are dropped even when it is the same page back on a fresh
	 * connection, where they would still be right - a second of re-measuring
	 * costs less than a rule about when stale state is safe to keep.
	 */
	const adoptHost = (link: PeerLink, hostName: string) => {
		const samePage = lastHostId === link.peerId;
		const replaced = lastHostId !== null && !samePage;
		hostLink = link;
		lastHostId = link.peerId;
		sync.reset();
		clock.reset();
		// The plan is the host's assignment of this room's guests to rungs, so a
		// different host's has to be waited for rather than carried over.
		if (replaced) meshPlan = null;

		if (replaced && loadedFilmId !== null) {
			// A different page is a different origin, and it has no file yet. The
			// film we hold cannot be continued from it, and keeping it would make
			// the same file picked again look like the film already playing.
			// Queued, so it lands ahead of any `ready` that follows.
			playback = playback.then(stopPlayback).catch((err: Error) => opts.onError(err));
		}
		// No mesh is built here: a mesh is per film, and `startPlayback` builds
		// one around whichever host is current when the film arrives.

		stats.candidateType = link.candidateType;
		opts.onHostName(hostName);

		// The same page, back on a new connection, with its film still loaded
		// here: pick up where `onPeerGone` left off rather than waiting for a
		// `ready` that will be recognised as a repeat and do nothing.
		if (samePage && loadedFilm) {
			sync.start();
			opts.onReady(loadedFilm);
		}
	};

	const onControl = (link: PeerLink, msg: ControlMessage) => {
		// Anything below this line is authoritative, so it must come from the
		// host and nobody else.
		const fromHost = hostLink !== null && link.peerId === hostLink.peerId;

		switch (msg.t) {
			case 'hello': {
				// The first hello from a peer is answered with ours. Our channels
				// are negotiated (channel.ts): they open the moment SCTP is up,
				// whether or not the remote has created its half, and anything sent
				// into that gap is silently discarded -- so the single hello sent
				// from onPeer can be lost to a peer that attached a beat later.
				// Both directions cannot lose it (each side only sends after
				// attaching its own channels, so mutual loss is a contradiction in
				// the timeline), which makes answering the surviving direction a
				// complete repair. Guarded to the first, so two peers answering
				// each other terminate instead of ping-ponging.
				const first = !helloSeen.has(link.peerId);
				helloSeen.add(link.peerId);
				if (first) link.channels.sendControl({ t: 'hello', role: 'guest', name });
				// Every name off the wire goes through the same gate the host puts
				// them through (identity.ts): the one that renders is the one that
				// was checked.
				const peerName = nameFrom(link.peerId, msg.name, msg.role === 'host' ? 'host' : 'guest');
				updatePeer(link.peerId, { name: peerName, role: msg.role === 'host' ? 'host' : 'guest' });
				if (msg.role === 'host') {
					hostClaims.set(link.peerId, { link, name: peerName });
					if (hostLink === null) adoptHost(link, peerName);
					// A repeated hello from our own host (the answer above is one
					// source; the probe-and-real handlers on the host are another)
					// changes nothing but possibly the name. One from anybody else
					// is a claim, and `hostClaims` is where those wait.
					else if (hostLink === link) opts.onHostName(peerName);
				}
				break;
			}

			// Only the host's own name is ours to render. Another guest's reaches us
			// through the host's roster, which is the only complete view of the room
			// (see `Roster` in protocol/control) - taking it from the peer directly
			// would name whoever the mesh happened to link us to and silently omit
			// the rest.
			case 'rename': {
				const peerName = nameFrom(link.peerId, msg.name, fromHost ? 'host' : 'guest');
				updatePeer(link.peerId, { name: peerName });
				const claim = hostClaims.get(link.peerId);
				if (claim) claim.name = peerName;
				if (fromHost) opts.onHostName(peerName);
				break;
			}

			case 'ready':
				if (!fromHost) break;
				if (typeof msg.film !== 'string' || typeof msg.mpd !== 'string') break;
				queuePlayback(
					msg.film,
					msg.mpd,
					Number.isFinite(msg.duration) ? msg.duration : 0,
					remoteTitle(msg.title)
				);
				break;

			case 'unplayable':
				if (fromHost && isFault(msg.fault)) opts.onUnplayable(msg.fault);
				break;

			case 'switchFailed':
				if (fromHost && isFault(msg.fault)) opts.onSwitchFailed(remoteTitle(msg.title), msg.fault);
				break;

			case 'state':
				if (fromHost) sync.apply(msg);
				break;

			case 'rungs': {
				if (!fromHost) break;
				const available = Array.isArray(msg.available)
					? msg.available.filter((r): r is number => Number.isInteger(r) && r >= 0)
					: [];
				stats.availableRungs = available;
				if (player && loadedFilmId) configurePlayer(player, { availableRungs: available });
				break;
			}

			case 'waiting':
				if (fromHost) opts.onWaiting(nameArray(msg.on), msg.you === true);
				break;

			case 'roster':
				if (fromHost)
					opts.onCompany({
						host: nameFrom(link.peerId, msg.host, 'host'),
						guests: nameArray(msg.guests)
					});
				break;

			case 'paused':
				if (fromHost)
					opts.onPaused(msg.by === null ? null : remoteName(msg.by, ''), msg.you === true);
				break;

			case 'pong':
				if (fromHost) clock.onPong(msg);
				break;

			case 'segErr':
				// `pending` holds requests made to the host, so only the host can
				// fail one. Mesh requests have their own ids and their own handler.
				if (!fromHost) break;
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

			case 'meshPlan':
				// The host dealing out fetch diversity (see `MeshPlan` in
				// protocol/control). mesh.setPlan validates the numbers; the check
				// here is only that it is the host talking, like every other
				// message that steers us.
				if (!fromHost) break;
				meshPlan = { slot: msg.slot, of: msg.of, rungs: msg.rungs };
				mesh?.setPlan(msg.slot, msg.of, msg.rungs);
				break;

			case 'segReq': {
				// Another guest pulling from our cache (PLAN.md Phase 5). Serving
				// is the same code path as the host's, minus the origin.
				const bytes = mesh?.serve(link.peerId, msg.film, msg.repId, msg.track, msg.segIdx) ?? null;
				// Nothing to report either way it fails: a cancel means the peer has
				// stopped waiting, and a link that died mid-send has nobody on it.
				if (bytes) link.channels.sendSegment(msg.reqId, bytes).catch(() => {});
				else
					link.channels.sendControl({
						t: 'segErr',
						reqId: msg.reqId,
						reason: 'not cached here'
					});
				break;
			}

			case 'segCancel':
				// The peer seeked away from a segment we are serving it.
				link.channels.cancelOutbound(msg.reqId);
				break;

			default:
				break;
		}
	};

	net.onPeer((link) => {
		updatePeer(link.peerId, { candidateType: link.candidateType });
		link.channels.onControl((msg) => onControl(link, msg));
		// Bytes for a request made to the host are only taken from the host. Any
		// peer in the room can put a frame on this channel under any reqId.
		link.channels.onSegment((reqId, payload) => {
			if (link.peerId === hostLink?.peerId) settle(reqId, (p) => p.resolve(payload));
		});
		link.channels.sendControl({ t: 'hello', role: 'guest', name });
	});

	net.onPeerGone((peerId) => {
		helloSeen.delete(peerId);
		hostClaims.delete(peerId);
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
			// The room is over unless someone else here has already said they
			// host it, which is what a host who reloaded looks like from a guest
			// that noticed the new page before it noticed the old one die.
			const next = hostClaims.values().next().value;
			if (next) {
				adoptHost(next.link, next.name);
				// Whatever it told us while we were following someone else was
				// dropped on arrival, `ready` included, and it has no reason to say
				// any of it twice. A hello is what makes a host state the room from
				// the top (host.ts answers every one with `ready` and the rest).
				next.link.channels.sendControl({ t: 'hello', role: 'guest', name });
			}
		}
	});

	net.onError((err) => opts.onError(err));

	// Rendezvous resolved on a peer, and a host that is there says hello within
	// a round trip. If none has by now, the room has people and no host, and
	// the screen should say that rather than "looking for the room" forever.
	const hostHelloTimer = setTimeout(() => {
		if (!closed && hostLink === null) opts.onNoHost();
	}, HOST_HELLO_MS);

	const statusTimer = setInterval(() => {
		if (!hostLink || !player || loadedFilmId === null) return;
		const bufferedAhead = playerBufferAhead(player, opts.video);
		const rung = currentRung(player);
		stats.bufferedAhead = bufferedAhead;
		stats.rung = rung;
		stats.bandwidthEstimate = bandwidthEstimate(player);
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
			atEnd: playerAtEnd(player, opts.video, BARRIER_LOW_SEC),
			rung,
			throughput: hostLink.channels.stats.throughputBps,
			name
		});
		mesh?.tick();
		mesh?.announce();
	}, STATUS_MS);

	return {
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
			closed = true;
			clearInterval(statusTimer);
			clearTimeout(hostHelloTimer);
			opts.video.removeEventListener('waiting', onStall);
			sync.stop();
			clock.stop();
			unregisterSyncStreamScheme();
			mesh?.close();
			mesh = null;
			void player?.destroy();
			player = null;
			net.close();
			void session.leave();
			// Through `settle`, so each request's watchdog interval goes with it.
			for (const reqId of [...pending.keys()])
				settle(reqId, (p) => p.reject(new Error('room closed')));
		}
	};
}

/** A film title off the wire, bounded like a name is (film.ts TITLE_MAX is the sender's bound). */
function remoteTitle(raw: unknown): string {
	return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
}

/** A list of names off the wire: only strings, each through `remoteName`, none empty. */
function nameArray(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw.map((n) => remoteName(n, '')).filter((n) => n !== '');
}
