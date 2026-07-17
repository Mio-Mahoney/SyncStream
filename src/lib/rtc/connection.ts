/**
 * The peer set (PLAN.md 7, Phase 1).
 *
 * The host announces on every strategy at once (PLAN.md 4.6), so a guest can
 * arrive on any session. This module flattens those sessions into one set of
 * links, takes the raw RTCPeerConnection each session exposes, and puts our own
 * channels on it. trystero is rendezvous; the media path is ours.
 *
 * Lifetime note: the RTCPeerConnection belongs to the session that created it.
 * We attach channels and listeners to it and remove them again, but we never
 * call pc.close() -- that is the session's to do on leave.
 */

import type { ControlMessage } from '$lib/protocol/control';
import type { RendezvousSession, StrategyName } from '$lib/rendezvous/transport';
import { type PeerChannels, attachChannels } from '$lib/rtc/channel';
import { type CandidateType, selectedCandidateType } from '$lib/rtc/ice';

export type PeerLink = {
	peerId: string;
	pc: RTCPeerConnection;
	channels: PeerChannels;
	strategy: StrategyName;
	/** Re-read on every ICE transition, so it tracks a mid-session ICE restart. */
	candidateType: CandidateType;
};

export type PeerNetwork = {
	/**
	 * Fires once the link's channels are ready. Links already up when you
	 * subscribe are replayed synchronously, so a late subscriber cannot silently
	 * miss a peer that connected while it was setting up.
	 */
	onPeer(cb: (link: PeerLink) => void): () => void;
	onPeerGone(cb: (peerId: string) => void): () => void;
	/** Announced links only; a peer still negotiating is not one yet. */
	links(): PeerLink[];
	get(peerId: string): PeerLink | undefined;
	broadcastControl(msg: ControlMessage): void;
	/**
	 * Surfaces failures that have no other route out, chiefly a session that
	 * hands back no RTCPeerConnection (PLAN.md 10: the whole approach rests on
	 * that connection existing). Unsubscribed errors go to the console rather
	 * than vanishing.
	 */
	onError(cb: (err: Error) => void): () => void;
	close(): void;
};

type PeerEntry = {
	link: PeerLink;
	/** The session whose pc this link was built on. Only it may end the link. */
	session: RendezvousSession;
	announced: boolean;
	teardown: () => void;
};

export function createPeerNetwork(sessions: RendezvousSession[]): PeerNetwork {
	/** Keyed by peerId, which is also the dedupe key across sessions. */
	const peers = new Map<string, PeerEntry>();
	const peerCbs = new Set<(link: PeerLink) => void>();
	const goneCbs = new Set<(peerId: string) => void>();
	const errCbs = new Set<(err: Error) => void>();
	let closed = false;

	function raise(err: Error): void {
		if (errCbs.size === 0) {
			console.error('[rtc]', err);
			return;
		}
		for (const cb of [...errCbs]) cb(err);
	}

	function drop(peerId: string): void {
		const entry = peers.get(peerId);
		if (!entry) return;
		// Deleted before teardown, so the close events teardown provokes re-enter
		// this function as a no-op instead of firing onPeerGone twice.
		peers.delete(peerId);
		entry.teardown();
		if (entry.announced) for (const cb of [...goneCbs]) cb(peerId);
		if (!closed) rejoinElsewhere(peerId, entry.session);
	}

	/**
	 * A dropped peer may still be live on another session.
	 *
	 * The host announces on every strategy at once (PLAN.md 4.6) while a guest
	 * walks the ladder, leaving one relay before joining the next. Those two
	 * events reach us over *different relays* and are therefore unordered: the
	 * arrival on nostr can land before the departure from mqtt is noticed, in
	 * which case DEDUPE below skipped the nostr join as a duplicate. Dropping the
	 * mqtt link would then lose the peer for good -- onPeerJoin has already fired
	 * for the session that still holds it and will not fire again.
	 *
	 * So on every drop, re-scan the other sessions for the peer. This is what
	 * makes the fall-through in PLAN.md 4.6 actually survive a strategy dying
	 * under a connected guest.
	 */
	function rejoinElsewhere(peerId: string, from: RendezvousSession): void {
		for (const s of sessions) {
			if (s === from) continue;
			if (s.peers().includes(peerId)) {
				void join(s, peerId);
				return;
			}
		}
	}

	async function join(session: RendezvousSession, peerId: string): Promise<void> {
		if (closed) return;
		// DEDUPE: trystero's selfId is per page load and identical across
		// strategies, so one guest can show up on several sessions. First wins.
		if (peers.has(peerId)) return;

		const pc = session.getPeerConnection(peerId);
		if (!pc) {
			raise(
				new Error(
					`rtc: ${session.strategy} exposed no RTCPeerConnection for peer ${peerId}; ` +
						'the media path cannot be built on this session (PLAN.md 10)'
				)
			);
			return;
		}

		let channels: PeerChannels;
		try {
			channels = attachChannels(pc, peerId);
		} catch (err) {
			// createDataChannel throws if our negotiated ids are already in use on
			// this connection, which means something else has claimed 100/101.
			// Nothing above us can recover from that, so say so plainly.
			raise(
				new Error(
					`rtc: could not attach channels to peer ${peerId} on ${session.strategy}: ${
						err instanceof Error ? err.message : String(err)
					}`
				)
			);
			return;
		}

		const link: PeerLink = {
			peerId,
			pc,
			channels,
			strategy: session.strategy,
			candidateType: 'unknown'
		};

		// Every relay candidate is a connection that would have needed TURN, and
		// every host/srflx one is a connection that did not. This measurement is
		// what decides PLAN.md 9, so it has to actually be collected.
		const readCandidate = (): void => {
			const st = pc.iceConnectionState;
			if (st !== 'connected' && st !== 'completed') return;
			void selectedCandidateType(pc).then((t) => {
				if (peers.get(peerId) === entry) link.candidateType = t;
			});
		};
		const onPcState = (): void => {
			const st = pc.connectionState;
			if (st === 'failed' || st === 'closed') drop(peerId);
		};

		const entry: PeerEntry = {
			link,
			session,
			announced: false,
			teardown: () => {
				pc.removeEventListener('iceconnectionstatechange', readCandidate);
				pc.removeEventListener('connectionstatechange', onPcState);
				channels.close();
			}
		};
		peers.set(peerId, entry);

		pc.addEventListener('iceconnectionstatechange', readCandidate);
		pc.addEventListener('connectionstatechange', onPcState);
		channels.onClose(() => drop(peerId));

		// This await is the one place a continuation outlives its own entry, so
		// every path out of it re-checks that the entry is still the current one.
		// `drop(peerId)` acts on whatever is registered under the id *now*, which
		// after a strategy migration is a different, healthy link.
		try {
			await channels.ready();
		} catch (err) {
			// An entry that is no longer current was already torn down by
			// whoever removed it (drop and close both call teardown), and that
			// teardown is itself why ready() rejected. Expected, not a fault.
			if (peers.get(peerId) !== entry) return;
			drop(peerId);
			raise(err instanceof Error ? err : new Error(String(err)));
			return;
		}
		// The peer may have left, or the network closed, while we were waiting.
		if (peers.get(peerId) !== entry) return;
		if (closed) {
			drop(peerId);
			return;
		}

		readCandidate();
		entry.announced = true;
		for (const cb of [...peerCbs]) cb(link);
	}

	for (const session of sessions) {
		session.onPeerJoin((peerId) => void join(session, peerId));
		// Only the session the link was built on may end it. A peer can be
		// present on several sessions (see DEDUPE), so a leave from any other
		// session is about a connection we never built anything on, and acting
		// on it would tear down a healthy link over an unrelated relay's news.
		session.onPeerLeave((peerId) => {
			if (peers.get(peerId)?.session === session) drop(peerId);
		});
		// A session handed to us with peers already on it would otherwise never
		// announce them: onPeerJoin only reports arrivals after registration.
		for (const peerId of session.peers()) void join(session, peerId);
	}

	return {
		onPeer(cb) {
			peerCbs.add(cb);
			for (const e of peers.values()) if (e.announced) cb(e.link);
			return () => peerCbs.delete(cb);
		},

		onPeerGone(cb) {
			goneCbs.add(cb);
			return () => goneCbs.delete(cb);
		},

		links: () => [...peers.values()].filter((e) => e.announced).map((e) => e.link),

		get(peerId) {
			const e = peers.get(peerId);
			return e?.announced ? e.link : undefined;
		},

		broadcastControl(msg: ControlMessage): void {
			for (const e of peers.values()) if (e.announced) e.link.channels.sendControl(msg);
		},

		onError(cb) {
			errCbs.add(cb);
			return () => errCbs.delete(cb);
		},

		close(): void {
			if (closed) return;
			closed = true;
			// Silent: the consumer is the one closing, so it does not need a gone
			// event per peer to know they went.
			for (const entry of [...peers.values()]) {
				peers.delete(entry.link.peerId);
				entry.teardown();
			}
			peerCbs.clear();
			goneCbs.clear();
			errCbs.clear();
			// The sessions are not ours to leave: we were handed them.
		}
	};
}
