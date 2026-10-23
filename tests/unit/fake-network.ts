/**
 * A PeerNetwork made of in-memory links, so the mesh can be driven without a
 * browser: each link records what it was sent and can be handed replies.
 */
import type { ControlMessage } from '$lib/protocol/control';
import type { PeerChannels } from '$lib/rtc/channel';
import type { PeerLink, PeerNetwork } from '$lib/rtc/connection';

export type FakeLink = PeerLink & {
	sent: ControlMessage[];
	expected: Set<number>;
	cancelledInbound: number[];
	/** Deliver a control message as if the remote sent it. */
	receive(msg: ControlMessage): void;
	/** Deliver a reassembled segment as if the remote sent it. */
	deliver(reqId: number, bytes: Uint8Array): void;
	recv: number;
};

export function fakeLink(peerId: string): FakeLink {
	const controlCbs = new Set<(m: ControlMessage) => void>();
	const segmentCbs = new Set<(reqId: number, b: Uint8Array) => void>();
	const link: FakeLink = {
		peerId,
		pc: {} as RTCPeerConnection,
		candidateType: 'host',
		sent: [],
		expected: new Set(),
		cancelledInbound: [],
		recv: 0,
		receive: (msg) => {
			for (const cb of [...controlCbs]) cb(msg);
		},
		deliver: (reqId, bytes) => {
			link.recv += bytes.byteLength;
			for (const cb of [...segmentCbs]) cb(reqId, bytes);
		},
		channels: {
			peerId,
			ready: () => Promise.resolve(),
			sendControl: (msg) => void link.sent.push(msg),
			sendSegment: () => Promise.resolve(),
			cancelOutbound: () => {},
			onControl: (cb) => {
				controlCbs.add(cb);
				return () => controlCbs.delete(cb);
			},
			onSegment: (cb) => {
				segmentCbs.add(cb);
				return () => segmentCbs.delete(cb);
			},
			expectInbound: (reqId) => void link.expected.add(reqId),
			cancelInbound: (reqId) => {
				link.expected.delete(reqId);
				link.cancelledInbound.push(reqId);
			},
			get stats() {
				return {
					bytesSent: 0,
					bytesRecv: link.recv,
					throughputBps: 1_000_000,
					outboundQueue: 0,
					pendingInbound: 0
				};
			},
			onClose: () => () => {},
			close: () => {}
		} satisfies PeerChannels
	};
	return link;
}

export function fakeNetwork(links: FakeLink[]): PeerNetwork & { gone(peerId: string): void } {
	const peerCbs = new Set<(l: PeerLink) => void>();
	const goneCbs = new Set<(id: string) => void>();
	const live = new Map(links.map((l) => [l.peerId, l]));
	return {
		onPeer(cb) {
			peerCbs.add(cb);
			for (const l of live.values()) cb(l);
			return () => peerCbs.delete(cb);
		},
		onPeerGone(cb) {
			goneCbs.add(cb);
			return () => goneCbs.delete(cb);
		},
		links: () => [...live.values()],
		get: (id) => live.get(id),
		broadcastControl: (msg) => {
			for (const l of live.values()) l.channels.sendControl(msg);
		},
		onError: () => () => {},
		close: () => {},
		gone(peerId) {
			live.delete(peerId);
			for (const cb of [...goneCbs]) cb(peerId);
		}
	};
}
