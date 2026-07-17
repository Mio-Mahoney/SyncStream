/**
 * The host half of a room.
 *
 * The host is the origin for its own file, the authority for playback state,
 * and the tracker for the Phase 5 mesh. It is also a participant, which is the
 * constraint that shapes everything here: nothing on this path may jank the
 * host's own playback (PLAN.md 4.5).
 */

import { filmTitle } from '$lib/film';
import { fallbackName, remoteName } from '$lib/identity';
import { createOrigin } from '$lib/media/origin';
import { probeFile, tierMessage } from '$lib/media/probe';
import type { Origin, ProbeResult } from '$lib/media/types';
import { createMesh, type Mesh } from '$lib/mesh/mesh';
import { INIT_SEGMENT, type ControlMessage, type Intent } from '$lib/protocol/control';
import { hostRoomChecked, shareLinkQuery, type HostRendezvous } from '$lib/rendezvous/room';
import { createPeerNetwork, type PeerLink, type PeerNetwork } from '$lib/rtc/connection';
import { removePeer, stats, updatePeer } from '$lib/stats.svelte';
import { HostState, ReadinessBarrier, type BlockedPeer } from '$lib/sync/state';
import { OCCUPANCY_PROBE_MS } from '$lib/rendezvous/room';

export type HostRoom = {
	readonly code: string;
	readonly shareUrl: string;
	setFile(file: File): Promise<ProbeResult>;
	/**
	 * Say who is hosting. `name` was only ever a fallback ("Host"), and the room
	 * is where it gets replaced - see identity.ts for why it is not asked for on
	 * the way in.
	 */
	setName(name: string): void;
	/**
	 * Our own play/pause/seek. Through here rather than straight into `state`,
	 * because a room that stops has to be able to say who stopped it - and this
	 * is the same funnel a guest's `intent` lands in, so both answers come out
	 * the same way.
	 */
	intent(action: Intent['action'], mediaTime: number): void;
	readonly state: HostState;
	readonly barrier: ReadinessBarrier;
	close(): void;
};

export type HostRoomOptions = {
	video: HTMLMediaElement;
	/** What to call ourselves until `setName` says otherwise. */
	name: string;
	origin: string;
	/**
	 * The code already in the room URL. We announce exactly this, so the code on
	 * screen is the code guests can join. If it collides with a live room we
	 * regenerate, and `HostRoom.code` is then the truth -- the caller must
	 * follow it.
	 */
	code: string;
	/** Called when the origin is ready and the host can start playing locally. */
	onSource: (o: { objectUrl: string | null; origin: Origin; title: string }) => void;
	onError: (err: Error) => void;
	onGuests: (guests: { peerId: string; name: string }[]) => void;
	onWaiting: (on: string[]) => void;
	/** Who stopped the film, by name, and whether that was us. Null once it runs again. */
	onPaused: (by: string | null, you: boolean) => void;
	signal?: AbortSignal;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startHostRoom(opts: HostRoomOptions): Promise<HostRoom> {
	let network: PeerNetwork | null = null;

	/**
	 * Mutable, and read at send time rather than captured: every guest already in
	 * the room when the host names themselves has to learn the new name, and the
	 * ones who arrive after it must be told the new one on their hello.
	 */
	let name = opts.name;

	/**
	 * PLAN.md 4.7's occupancy check. Codes are client-generated with no server
	 * to check collisions, so the only honest test is to knock: announce as a
	 * host and see whether a rival host answers. Rendezvous owns the retry
	 * policy; the hello handshake is ours, which is why it is a predicate.
	 */
	const rendezvous: HostRendezvous = await hostRoomChecked(
		async (r) => {
			const probe = createPeerNetwork(r.sessions);
			let occupied = false;
			probe.onPeer((link) => {
				link.channels.onControl((msg) => {
					if (msg.t === 'hello' && msg.role === 'host') occupied = true;
				});
				link.channels.sendControl({ t: 'hello', role: 'host', name });
			});
			await sleep(OCCUPANCY_PROBE_MS);
			if (occupied) {
				probe.close();
				return true;
			}
			network = probe;
			return false;
		},
		3,
		{ signal: opts.signal, code: opts.code }
	);

	const net = network as unknown as PeerNetwork;
	stats.role = 'host';
	stats.room = rendezvous.code;
	stats.strategy = rendezvous.primary;

	let origin: Origin | null = null;
	let objectUrl: string | null = null;
	/**
	 * The film's name, kept beside the origin it belongs to and read at send time
	 * so a guest who arrives mid-film is told what it is, exactly like one who was
	 * here when it went on. See film.ts.
	 */
	let title = '';
	const guestNames = new Map<string, string>();

	const mesh: Mesh = createMesh({
		network: net,
		// We are the origin. There is no upstream to fall back to.
		hostPeerId: null,
		fetchFromHost: async (repId, track, segIdx) => {
			if (!origin) throw new Error('host: no file selected yet');
			return segIdx === INIT_SEGMENT
				? origin.getInit(repId, track)
				: origin.getSegment(repId, track, segIdx);
		}
	});

	const state = new HostState(opts.video, (s) => net.broadcastControl(s));

	/**
	 * Per link, not broadcast. The barrier's whole purpose is to make a stalling
	 * guest visible, and the guest it names is the one person the broadcast
	 * cannot reach: they are never told which "Guest 412" is them, so the room's
	 * one explanation for why their film froze reads as news about a stranger.
	 * Each guest is told about the others by name, and about itself as "you".
	 */
	const sendWaiting = (link: PeerLink, blocked: readonly BlockedPeer[]) => {
		link.channels.sendControl({
			t: 'waiting',
			on: blocked.filter((b) => b.peerId !== link.peerId).map((b) => b.name),
			you: blocked.some((b) => b.peerId === link.peerId)
		});
	};

	const announceWaiting = (blocked: readonly BlockedPeer[]) => {
		for (const link of net.links()) sendWaiting(link, blocked);
		// The host is not a guest, so nothing here is ever about them.
		opts.onWaiting(blocked.map((b) => b.name));
	};

	const barrier = new ReadinessBarrier({
		onPause: (blocked) => {
			state.pause();
			announceWaiting(blocked);
		},
		onResume: () => {
			state.resume();
			announceWaiting([]);
		}
	});

	/**
	 * Whoever last paused the film on purpose. `peerId: null` means us, and no box
	 * at all means nothing deliberate stopped it.
	 *
	 * Both identities, for the reason `BlockedPeer` carries both: the id is what
	 * decides who to say the sentence to, and it is also what keeps the name fresh
	 * - names change (`rename`), and a room still saying "Guest 412 paused the
	 * film" about someone who has since introduced themselves as Bob is naming a
	 * stranger. `name` is the reading at the moment they paused, which is what the
	 * lookup falls back to once they leave: the film is still stopped, they are
	 * still why, and dropping the sentence when its subject walks out would put
	 * the room back where it started - halted, with no account of it anywhere.
	 */
	let pausedBy: { peerId: string | null; name: string } | null = null;

	const pauserName = (): string | null =>
		pausedBy === null
			? null
			: pausedBy.peerId === null
				? name
				: (guestNames.get(pausedBy.peerId) ?? pausedBy.name);

	/**
	 * Per link, like `waiting` and for the same reason: the person who cannot be
	 * told "Bob paused the film" is Bob. They pressed pause a moment ago and know
	 * exactly why the film stopped; the sentence is for everyone else.
	 */
	const announcePause = () => {
		const by = pauserName();
		for (const link of net.links()) {
			link.channels.sendControl({
				t: 'paused',
				by,
				you: pausedBy !== null && pausedBy.peerId === link.peerId
			});
		}
		opts.onPaused(by, pausedBy !== null && pausedBy.peerId === null);
	};

	/**
	 * Every deliberate play, pause and seek in the room, ours included, so there
	 * is one place that knows who asked. The barrier's brake deliberately does not
	 * come through here: it has its own banner, and it is not a person.
	 */
	const applyIntentFrom = (peerId: string | null, i: Intent) => {
		if (i.action === 'pause')
			pausedBy = { peerId, name: peerId === null ? name : (guestNames.get(peerId) ?? '') };
		else if (i.action === 'play') pausedBy = null;
		// A seek leaves it alone: it does not stop or start the film, so whoever
		// stopped it still stopped it.
		state.applyIntent(i);
		if (i.action !== 'seek') announcePause();
	};

	const announceGuests = () => {
		opts.onGuests([...guestNames].map(([peerId, name]) => ({ peerId, name })));
		announceRoster();
		// A rename changes the answer to "who paused this", and the roster is
		// exactly when the room re-states who its people are.
		announcePause();
	};

	/**
	 * Tell each guest who they are watching with. Ours is the only complete view
	 * of the room - a guest sees only the peers the mesh happened to link it to -
	 * so this cannot be left for them to work out (see `Roster` in
	 * protocol/control).
	 *
	 * Tailored per link: the recipient is dropped from their own copy, since a
	 * guest is never told which display name is theirs and would read it as one
	 * more stranger in the room.
	 */
	const announceRoster = () => {
		for (const link of net.links()) {
			link.channels.sendControl({
				t: 'roster',
				host: name,
				guests: [...guestNames].filter(([id]) => id !== link.peerId).map(([, n]) => n)
			});
		}
	};

	const sendReady = (link: PeerLink) => {
		if (!origin) return;
		link.channels.sendControl({
			t: 'ready',
			mpd: origin.mpd,
			duration: origin.durationSec,
			title
		});
		link.channels.sendControl({ t: 'rungs', available: origin.availableRungs() });
		link.channels.sendControl(state.snapshot());
		// The state above may well be a paused one. A guest who arrives to a film
		// that is stopped needs the reason as much as the people who watched it
		// stop - more, since they never saw it running.
		link.channels.sendControl({
			t: 'paused',
			by: pauserName(),
			you: pausedBy !== null && pausedBy.peerId === link.peerId
		});
		// And the other reason a film sits still. The barrier only ever speaks on
		// a transition, and an arrival is not one: it re-fires when the blocked
		// list changes, and a healthy guest joining does not change who is behind.
		// Without this a guest walking into a stalled room reads nothing at all -
		// the one screen with no account of a frozen film is the newest one, which
		// has the least idea why.
		sendWaiting(link, barrier.waitingOn);
	};

	const serveSegment = async (link: PeerLink, msg: Extract<ControlMessage, { t: 'segReq' }>) => {
		const { reqId, repId, track, segIdx } = msg;
		try {
			if (!origin) throw new Error('the host has not picked a file yet');
			const bytes =
				segIdx === INIT_SEGMENT
					? await origin.getInit(repId, track)
					: await origin.getSegment(repId, track, segIdx);
			await link.channels.sendSegment(reqId, bytes);
		} catch (err) {
			if ((err as Error).name === 'AbortError') return;
			link.channels.sendControl({ t: 'segErr', reqId, reason: (err as Error).message });
		}
	};

	/**
	 * Every name a guest tells us about itself, through one gate, because all
	 * three ways it can arrive land somewhere the whole room reads. `remoteName`
	 * says why the wire cannot be taken at its word; the fallback here is what
	 * makes rejecting a name safe - the guest keeps the name they already had,
	 * and a guest whose very first word is junk still gets one.
	 */
	const nameFrom = (peerId: string, raw: unknown): string =>
		remoteName(raw, guestNames.get(peerId) ?? fallbackName('guest'));

	const onControl = (link: PeerLink, msg: ControlMessage) => {
		switch (msg.t) {
			case 'hello': {
				const guestName = nameFrom(link.peerId, msg.name);
				guestNames.set(link.peerId, guestName);
				updatePeer(link.peerId, { name: guestName, role: msg.role });
				announceGuests();
				sendReady(link);
				break;
			}

			// A guest has said who it is, replacing the fallback it arrived under.
			// Every name in the room is ours to hold and ours to state, so this
			// lands in the same place its hello did and re-states the roster from
			// there - which is what carries the new name to the other guests.
			case 'rename': {
				const guestName = nameFrom(link.peerId, msg.name);
				guestNames.set(link.peerId, guestName);
				updatePeer(link.peerId, { name: guestName });
				// The pause box holds a name as well as an id, and it is the name
				// that outlives the peer: `pauserName` falls back to it the moment
				// they leave. Renaming without refreshing it here is what leaves the
				// room announcing a pause under a name its subject never used - the
				// exact staleness the id is carried to prevent.
				if (pausedBy?.peerId === link.peerId) pausedBy.name = guestName;
				announceGuests();
				break;
			}

			case 'segReq':
				void serveSegment(link, msg);
				break;

			case 'segCancel':
				// The host does not queue sends per request; the guest dropping
				// its reassembly is what actually frees the memory. Nothing to do
				// beyond not treating the late arrival as an error.
				break;

			case 'ping':
				link.channels.sendControl({ t: 'pong', t0: msg.t0, t1: Date.now() });
				break;

			case 'intent':
				// PLAN.md 4.9: guests send intent, the host decides and broadcasts.
				applyIntentFrom(link.peerId, msg);
				break;

			case 'status': {
				// Through the same gate as the other two: this name reaches the
				// barrier, and "Waiting for X to catch up" is the one sentence in the
				// room that a stalled guest's own status message gets to write.
				const guestName = nameFrom(link.peerId, msg.name);
				guestNames.set(link.peerId, guestName);
				updatePeer(link.peerId, {
					bufferedAhead: msg.bufferedAhead,
					rung: msg.rung,
					throughputBps: msg.throughput
				});
				barrier.report(link.peerId, guestName, msg.bufferedAhead);
				break;
			}

			case 'have':
				mesh.handleHave(link.peerId, msg.keys);
				break;

			case 'sourcesReq':
				link.channels.sendControl({
					t: 'sourcesRes',
					reqId: msg.reqId,
					sources: mesh.sources(msg.keys)
				});
				break;

			default:
				// A guest sending us `state` would be a guest trying to command the
				// room. PLAN.md 4.9 says that never happens; ignoring it is what
				// makes that true rather than aspirational.
				break;
		}
	};

	net.onPeer((link) => {
		updatePeer(link.peerId, { role: 'guest', candidateType: link.candidateType });
		link.channels.onControl((msg) => onControl(link, msg));
		link.channels.sendControl({ t: 'hello', role: 'host', name });
		sendReady(link);
	});

	net.onPeerGone((peerId) => {
		guestNames.delete(peerId);
		barrier.remove(peerId);
		removePeer(peerId);
		announceGuests();
	});

	net.onError((err) => opts.onError(err));

	const setFile = async (file: File): Promise<ProbeResult> => {
		const probe = await probeFile(file);
		stats.tier = probe.tier;

		if (probe.tier === 'reject') {
			const reason = tierMessage(probe, true);
			net.broadcastControl({ t: 'unplayable', reason });
			throw new Error(reason);
		}

		// Past the rejection, so a file we would not play never renames the film
		// that is on - the same rule `converting` follows on the page, and for the
		// same reason: a rejected file displaced nothing.
		title = filmTitle(file.name);
		// Nobody has paused this film - it has not started. Kept here beside the
		// title for the same reason: a second film supersedes the first, and an
		// attribution carried over would explain the new film's stillness with a
		// decision somebody made about the old one.
		pausedBy = null;

		origin?.close();
		if (objectUrl) URL.revokeObjectURL(objectUrl);
		origin = await createOrigin(file, probe);

		// A directly-playable file needs no MSE on the host: it has the file on
		// disk, so it plays it. Segmenting for our own playback would cost the
		// host CPU to arrive at a worse copy of what it already has. Tier-2
		// files have no such shortcut and go through the same origin the guests
		// pull from.
		objectUrl = probe.tier === 'direct' ? URL.createObjectURL(file) : null;

		origin.onRungsChanged((available) => {
			stats.availableRungs = available;
			net.broadcastControl({ t: 'rungs', available });
		});
		stats.availableRungs = origin.availableRungs();

		opts.onSource({ objectUrl, origin, title });
		for (const link of net.links()) sendReady(link);
		state.start();
		return probe;
	};

	return {
		code: rendezvous.code,
		shareUrl: `${opts.origin}/room/${rendezvous.code}${shareLinkQuery(rendezvous.primary)}`,
		setFile,
		/**
		 * Broadcast, not left to the roster. A guest still waiting for a file knows
		 * us only by the name on our hello - the roster is not sent until there is a
		 * room to report - so without this the people most likely to be reading
		 * "Connected to Host" are the last to learn it is not called that.
		 */
		setName: (n: string) => {
			name = n;
			net.broadcastControl({ t: 'rename', name: n });
			announceRoster();
			// Our own name is one of the answers to "who paused this".
			announcePause();
		},
		// `null` is us: we have no peer id of our own to compare a link against,
		// and every link that is not the pauser is being told about someone else.
		intent: (action, mediaTime) => applyIntentFrom(null, { t: 'intent', action, mediaTime }),
		state,
		barrier,
		close: () => {
			state.stop();
			mesh.close();
			net.close();
			void rendezvous.leave();
			origin?.close();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		}
	};
}
