/**
 * The host half of a room.
 *
 * The host is the origin for its own file, the authority for playback state,
 * and the tracker for the Phase 5 mesh. It is also a participant, which is the
 * constraint that shapes everything here: nothing on this path may jank the
 * host's own playback (PLAN.md 4.5).
 */

import { createOrigin } from '$lib/media/origin';
import { probeFile, tierMessage } from '$lib/media/probe';
import type { Origin, ProbeResult } from '$lib/media/types';
import { createMesh, type Mesh } from '$lib/mesh/mesh';
import { INIT_SEGMENT, type ControlMessage, type Intent } from '$lib/protocol/control';
import { hostRoomChecked, shareLinkQuery, type HostRendezvous } from '$lib/rendezvous/room';
import { createPeerNetwork, type PeerLink, type PeerNetwork } from '$lib/rtc/connection';
import { removePeer, stats, updatePeer } from '$lib/stats.svelte';
import { HostState, ReadinessBarrier } from '$lib/sync/state';
import { OCCUPANCY_PROBE_MS } from '$lib/rendezvous/room';

export type HostRoom = {
	readonly code: string;
	readonly shareUrl: string;
	setFile(file: File): Promise<ProbeResult>;
	readonly state: HostState;
	readonly barrier: ReadinessBarrier;
	close(): void;
};

export type HostRoomOptions = {
	video: HTMLMediaElement;
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
	onSource: (o: { objectUrl: string | null; origin: Origin }) => void;
	onError: (err: Error) => void;
	onGuests: (guests: { peerId: string; name: string }[]) => void;
	onWaiting: (on: string[]) => void;
	signal?: AbortSignal;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startHostRoom(opts: HostRoomOptions): Promise<HostRoom> {
	let network: PeerNetwork | null = null;

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
				link.channels.sendControl({ t: 'hello', role: 'host', name: opts.name });
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

	const barrier = new ReadinessBarrier({
		onPause: (waitingOn) => {
			state.pause();
			net.broadcastControl({
				t: 'waiting',
				on: waitingOn.map((p) => guestNames.get(p) ?? 'a guest')
			});
			opts.onWaiting(waitingOn.map((p) => guestNames.get(p) ?? 'a guest'));
		},
		onResume: () => {
			state.resume();
			net.broadcastControl({ t: 'waiting', on: [] });
			opts.onWaiting([]);
		}
	});

	const announceGuests = () =>
		opts.onGuests([...guestNames].map(([peerId, name]) => ({ peerId, name })));

	const sendReady = (link: PeerLink) => {
		if (!origin) return;
		link.channels.sendControl({ t: 'ready', mpd: origin.mpd, duration: origin.durationSec });
		link.channels.sendControl({ t: 'rungs', available: origin.availableRungs() });
		link.channels.sendControl(state.snapshot());
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

	const onControl = (link: PeerLink, msg: ControlMessage) => {
		switch (msg.t) {
			case 'hello':
				guestNames.set(link.peerId, msg.name);
				updatePeer(link.peerId, { name: msg.name, role: msg.role });
				announceGuests();
				sendReady(link);
				break;

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
				applyIntent(msg);
				break;

			case 'status':
				guestNames.set(link.peerId, msg.name);
				updatePeer(link.peerId, {
					bufferedAhead: msg.bufferedAhead,
					rung: msg.rung,
					throughputBps: msg.throughput
				});
				barrier.report(link.peerId, msg.name, msg.bufferedAhead);
				break;

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

	const applyIntent = (i: Intent) => {
		state.applyIntent(i);
	};

	net.onPeer((link) => {
		updatePeer(link.peerId, { role: 'guest', candidateType: link.candidateType });
		link.channels.onControl((msg) => onControl(link, msg));
		link.channels.sendControl({ t: 'hello', role: 'host', name: opts.name });
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

		opts.onSource({ objectUrl, origin });
		for (const link of net.links()) sendReady(link);
		state.start();
		return probe;
	};

	return {
		code: rendezvous.code,
		shareUrl: `${opts.origin}/room/${rendezvous.code}${shareLinkQuery(rendezvous.primary)}`,
		setFile,
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
