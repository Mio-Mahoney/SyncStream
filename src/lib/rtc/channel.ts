/**
 * The two data channels we run per peer (PLAN.md 7, Phase 1).
 *
 *   control  id 100  ordered, reliable, JSON
 *   data     id 101  ordered, reliable, binary
 *
 * Both are `negotiated: true`, and that is not a style preference. trystero's
 * own peer implementation calls `pc.createDataChannel('data')` on the initiator
 * and keeps the responder's side via `pc.ondatachannel`. An in-band channel of
 * ours would fire that same handler on the remote and clobber trystero's
 * reference to its own channel, breaking the rendezvous we are riding on.
 * Negotiated channels never fire `ondatachannel`. They also need no
 * renegotiation: trystero's channel has already established the SCTP m-line, so
 * ours join the existing association.
 *
 * The ids are deliberately far from the low ones trystero's channel is
 * auto-assigned, so we cannot collide with it.
 *
 * Backpressure lives here, in `gate`. It is the fix for the OOM in PLAN.md 2:
 * without it the send loop queues the whole file into the SCTP buffer as fast
 * as JS can iterate, and the tab dies.
 */

import { type ControlMessage, decodeControl, encodeControl } from '$lib/protocol/control';
import {
	HEADER_BYTES,
	Reassembler,
	WireMsgType,
	chunk,
	decodeFrame,
	encodeFrame
} from '$lib/protocol/wire';

export const CONTROL_CHANNEL_ID = 100;
export const DATA_CHANNEL_ID = 101;

/** Stop feeding the SCTP buffer above this. */
/**
 * A shared token bucket over every outbound segment byte, i.e. this process's
 * uplink. Null means unshaped, which is the only state a user ever sees.
 *
 * This exists because PLAN.md 8 is wrong about how to drive the
 * network-dependent acceptance criteria. It prescribes CDP
 * `Network.emulateNetworkConditions`, which does not touch WebRTC at all:
 * measured on this machine, a data channel capped at 1.5 Mbps still moved
 * 233 Mbps, versus 246 Mbps unshaped. CDP shapes the HTTP stack, not SCTP over
 * UDP.
 *
 * Shaping our own send path is the honest substitute, and it is closer to the
 * thing being modelled than CDP would have been anyway: PLAN.md 5's binding
 * constraint is the host's uplink, and this is exactly that number. It is inert
 * unless a test sets it (see `window.__syncstream.throttle`), and it is
 * deliberately shared across links, because a host has one uplink and not one
 * per guest.
 */
let uplinkCapBps: number | null = null;
let tokens = 0;
let lastRefill = 0;

/** Bytes/sec, or null to unshape. */
export function setUplinkCap(bytesPerSec: number | null): void {
	uplinkCapBps = bytesPerSec;
	tokens = 0;
	lastRefill = performance.now();
}

export function uplinkCap(): number | null {
	return uplinkCapBps;
}

async function spend(bytes: number): Promise<void> {
	if (uplinkCapBps === null) return;
	for (;;) {
		const now = performance.now();
		const cap = uplinkCapBps;
		if (cap === null) return;
		tokens = Math.min(cap, tokens + ((now - lastRefill) / 1000) * cap);
		lastRefill = now;
		if (tokens >= bytes) {
			tokens -= bytes;
			return;
		}
		const waitMs = ((bytes - tokens) / cap) * 1000;
		await new Promise((r) => setTimeout(r, Math.max(1, Math.ceil(waitMs))));
	}
}

export const HIGH_WATER = 1024 * 1024;
/** Resume once it has drained to here. Keeps the buffer in a 256KB-1MB band. */
export const LOW_WATER = 256 * 1024;

/**
 * Throughput is a sliding window over real time rather than an EWMA. An EWMA
 * needs a minimum sample interval to keep bytes/dt from exploding, and that
 * floor makes it read zero for a burst that starts and finishes inside it --
 * which is exactly the moment Shaka asks for `defaultBandwidthEstimate` after
 * the first segment lands. Bucketing sidesteps that: fixed memory, no divide by
 * a near-zero dt, and it falls to zero on its own once the window ages out.
 */
const TP_WINDOW_MS = 2000;
const TP_BUCKETS = 20;
const TP_BUCKET_MS = TP_WINDOW_MS / TP_BUCKETS;

/**
 * How many cancelled reqIds to remember. Frames already handed to SCTP keep
 * arriving after a cancel, and the window of those in flight is bounded by
 * HIGH_WATER (~16 chunks), so this is orders of magnitude more than enough.
 */
const CANCEL_MEMORY = 256;

export type ChannelStats = {
	bytesSent: number;
	bytesRecv: number;
	throughputBps: number;
	outboundQueue: number;
	pendingInbound: number;
};

export type PeerChannels = {
	readonly peerId: string;
	/** Resolves when both channels are open; rejects if either dies first. */
	ready(): Promise<void>;
	sendControl(msg: ControlMessage): void;
	sendSegment(reqId: number, payload: Uint8Array, signal?: AbortSignal): Promise<void>;
	onControl(cb: (msg: ControlMessage) => void): () => void;
	onSegment(cb: (reqId: number, payload: Uint8Array) => void): () => void;
	cancelInbound(reqId: number): void;
	readonly stats: ChannelStats;
	onClose(cb: () => void): () => void;
	close(): void;
};

function abortError(): DOMException {
	return new DOMException('sendSegment aborted', 'AbortError');
}

export function attachChannels(pc: RTCPeerConnection, peerId: string): PeerChannels {
	const control = pc.createDataChannel('control', {
		negotiated: true,
		id: CONTROL_CHANNEL_ID,
		ordered: true
	});
	let data: RTCDataChannel;
	try {
		data = pc.createDataChannel('data', {
			negotiated: true,
			id: DATA_CHANNEL_ID,
			ordered: true
		});
	} catch (err) {
		// Half-built is not a state we hand back or leave behind: the caller
		// treats a throw here as "no channels on this peer" and never gets a
		// handle to close `control` with, so it would sit open on a pc that
		// outlives us.
		control.close();
		throw err;
	}
	data.binaryType = 'arraybuffer';
	data.bufferedAmountLowThreshold = LOW_WATER;

	const reassembler = new Reassembler();
	const controlCbs = new Set<(msg: ControlMessage) => void>();
	const segmentCbs = new Set<(reqId: number, payload: Uint8Array) => void>();

	/**
	 * Control messages that arrived before anyone subscribed, replayed to the
	 * first subscriber. Null once that replay has happened.
	 *
	 * This exists because our channels are negotiated (4.6): a negotiated
	 * channel opens as soon as the SCTP transport is up, whether or not the
	 * remote has created its half. The host is always in the room first, so it
	 * attaches and sends `hello` while the guest is still between `ready()` and
	 * registering its handler. Dropping those bytes loses `hello` and `ready`
	 * outright -- they are each sent once -- and the guest waits forever for a
	 * host it is already connected to.
	 *
	 * This buffer covers only the attached-but-not-listening half of that
	 * window. The harsher half -- the remote has not called createDataChannel
	 * at all yet, so SCTP discards the bytes before any object exists to
	 * buffer them -- cannot be fixed on the receiving side, because there is
	 * no receiving side. The hello handshake repairs it at the protocol level
	 * instead: the first hello received on a link is answered with our own
	 * (host.ts / guest.ts), and both directions cannot fall in the gap, since
	 * each side only sends after attaching its own channels.
	 */
	let earlyControl: ControlMessage[] | null = [];
	/** A peer cannot make us buffer without bound before we have even listened. */
	const EARLY_CONTROL_MAX = 64;
	const closeCbs = new Set<() => void>();
	/** Senders parked in `gate`, so a close does not leave them awaiting forever. */
	const gateWaiters = new Set<() => void>();
	/** Insertion-ordered, so the oldest entry is the one to evict. */
	const cancelled = new Set<number>();

	let bytesSent = 0;
	let bytesRecv = 0;
	let closed = false;

	// Throughput: received bytes per 100ms bucket over a rolling 2s window.
	const tpBuckets = new Float64Array(TP_BUCKETS);
	const tpStart = performance.now();
	let tpEpoch = Math.floor(tpStart / TP_BUCKET_MS);

	/** Zeroes the buckets that real time has moved past since the last touch. */
	function tpAdvance(now: number): void {
		const epoch = Math.floor(now / TP_BUCKET_MS);
		if (epoch === tpEpoch) return;
		const stale = Math.min(epoch - tpEpoch, TP_BUCKETS);
		for (let i = 1; i <= stale; i++) tpBuckets[(tpEpoch + i) % TP_BUCKETS] = 0;
		tpEpoch = epoch;
	}

	function recorded(bytes: number): void {
		const now = performance.now();
		bytesRecv += bytes;
		tpAdvance(now);
		tpBuckets[tpEpoch % TP_BUCKETS] += bytes;
	}

	function throughput(): number {
		const now = performance.now();
		tpAdvance(now);
		let sum = 0;
		for (const b of tpBuckets) sum += b;
		if (sum === 0) return 0;
		// Divide by the time actually observed, not the nominal window, so a link
		// younger than 2s is not under-reported by the empty part of its history.
		const spanMs = Math.min(Math.max(now - tpStart, TP_BUCKET_MS), TP_WINDOW_MS);
		return (sum * 1000) / spanMs;
	}

	function shutdown(): void {
		if (closed) return;
		closed = true;

		control.removeEventListener('message', onControlMessage);
		data.removeEventListener('message', onDataMessage);
		for (const dc of [control, data]) {
			dc.removeEventListener('close', shutdown);
			dc.removeEventListener('error', shutdown);
			try {
				dc.close();
			} catch {
				// Already gone with the connection; nothing to unwind.
			}
		}
		// The pc belongs to trystero. We only ever own the channels on it.

		for (const wake of [...gateWaiters]) wake();
		gateWaiters.clear();
		reassembler.clear();
		cancelled.clear();

		const cbs = [...closeCbs];
		closeCbs.clear();
		controlCbs.clear();
		segmentCbs.clear();
		for (const cb of cbs) cb();
	}

	function onControlMessage(ev: MessageEvent): void {
		if (typeof ev.data !== 'string') return; // control is JSON only
		recorded(ev.data.length);
		const msg = decodeControl(ev.data);
		if (!msg) return; // a peer sending garbage is a peer to ignore, not a room to tear down
		if (controlCbs.size === 0 && earlyControl !== null) {
			if (earlyControl.length < EARLY_CONTROL_MAX) earlyControl.push(msg);
			return;
		}
		for (const cb of [...controlCbs]) cb(msg);
	}

	function onDataMessage(ev: MessageEvent): void {
		if (!(ev.data instanceof ArrayBuffer)) return;
		recorded(ev.data.byteLength);

		let done: Uint8Array | null;
		let reqId: number;
		try {
			const frame = decodeFrame(ev.data);
			if (frame.type !== WireMsgType.SegData) return;
			if (cancelled.has(frame.requestId)) return;
			reqId = frame.requestId;
			done = reassembler.push(frame);
		} catch {
			// Malformed framing costs us one dropped request, not the connection.
			return;
		}
		if (!done) return;
		for (const cb of [...segmentCbs]) cb(reqId, done);
	}

	control.addEventListener('message', onControlMessage);
	data.addEventListener('message', onDataMessage);
	for (const dc of [control, data]) {
		dc.addEventListener('close', shutdown);
		dc.addEventListener('error', shutdown);
	}

	function channelReady(dc: RTCDataChannel): Promise<void> {
		if (dc.readyState === 'open') return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const off = (): void => {
				dc.removeEventListener('open', onOpen);
				dc.removeEventListener('close', onFail);
				dc.removeEventListener('error', onFail);
			};
			const onOpen = (): void => {
				off();
				resolve();
			};
			const onFail = (): void => {
				off();
				reject(new Error(`channel: ${dc.label} to ${peerId} died before it opened`));
			};
			dc.addEventListener('open', onOpen);
			dc.addEventListener('close', onFail);
			dc.addEventListener('error', onFail);
		});
	}

	const readyPromise = Promise.all([channelReady(control), channelReady(data)]).then(
		() => undefined
	);
	// ready() may be called long after attach, or never. Keep a failure from
	// surfacing as an unhandled rejection in the meantime.
	readyPromise.catch(() => {});

	/**
	 * The awaited backpressure gate. Returns immediately while the SCTP buffer
	 * has room; otherwise parks the caller until 'bufferedamountlow' fires.
	 *
	 * Checking bufferedAmount and registering the listener happen in the same
	 * synchronous turn, so the event cannot slip through between them.
	 */
	function gate(signal?: AbortSignal): Promise<void> {
		if (closed) return Promise.reject(new Error(`channel: link to ${peerId} is closed`));
		if (data.bufferedAmount <= HIGH_WATER) return Promise.resolve();

		return new Promise<void>((resolve, reject) => {
			const off = (): void => {
				data.removeEventListener('bufferedamountlow', onLow);
				signal?.removeEventListener('abort', onAbort);
				gateWaiters.delete(onClosed);
			};
			const onLow = (): void => {
				off();
				resolve();
			};
			const onAbort = (): void => {
				off();
				reject(abortError());
			};
			const onClosed = (): void => {
				off();
				reject(new Error(`channel: link to ${peerId} closed mid-send`));
			};
			data.addEventListener('bufferedamountlow', onLow);
			signal?.addEventListener('abort', onAbort, { once: true });
			gateWaiters.add(onClosed);
		});
	}

	return {
		peerId,

		ready: () => readyPromise,

		sendControl(msg: ControlMessage): void {
			// Dropped rather than thrown: a peer disappearing mid-broadcast is
			// routine, and every call site guarding readyState would be noise.
			// onClose is the signal that the link is gone.
			if (control.readyState !== 'open') return;
			const raw = encodeControl(msg);
			control.send(raw);
			bytesSent += raw.length;
		},

		async sendSegment(reqId: number, payload: Uint8Array, signal?: AbortSignal): Promise<void> {
			const chunks = chunk(payload);
			const total = chunks.length;
			for (let i = 0; i < total; i++) {
				if (signal?.aborted) throw abortError();
				await gate(signal);
				await spend(chunks[i]!.byteLength + HEADER_BYTES);
				if (signal?.aborted) throw abortError();
				if (data.readyState !== 'open') {
					throw new Error(`channel: link to ${peerId} closed after ${i}/${total} chunks`);
				}
				const frame = encodeFrame(WireMsgType.SegData, reqId, i, total, chunks[i]);
				data.send(frame);
				bytesSent += frame.byteLength;
			}
		},

		onControl(cb) {
			controlCbs.add(cb);
			if (earlyControl !== null) {
				const queued = earlyControl;
				earlyControl = null;
				// A microtask, not a synchronous replay: the caller registers
				// onControl and onSegment back to back, and delivering `ready`
				// inside the first call would start playback before the segment
				// handler exists, so every segment reply would be dropped instead.
				if (queued.length > 0) {
					queueMicrotask(() => {
						for (const msg of queued) {
							if (closed) return;
							cb(msg);
						}
					});
				}
			}
			return () => controlCbs.delete(cb);
		},

		onSegment(cb) {
			segmentCbs.add(cb);
			return () => segmentCbs.delete(cb);
		},

		cancelInbound(reqId: number): void {
			reassembler.cancel(reqId);
			// Dropping the partial is not enough on its own: chunks already handed
			// to SCTP keep arriving and would open a fresh entry that never
			// completes and so is never freed. Every cancelled seek would leak
			// its in-flight window.
			cancelled.add(reqId);
			if (cancelled.size > CANCEL_MEMORY) {
				const oldest = cancelled.values().next().value;
				if (oldest !== undefined) cancelled.delete(oldest);
			}
		},

		get stats(): ChannelStats {
			return {
				bytesSent,
				bytesRecv,
				// Control traffic is a few hundred bytes per second against a media
				// stream, so it is folded in rather than tracked apart.
				throughputBps: throughput(),
				outboundQueue: data.bufferedAmount + control.bufferedAmount,
				pendingInbound: reassembler.pendingBytes
			};
		},

		onClose(cb) {
			if (closed) {
				cb();
				return () => {};
			}
			closeCbs.add(cb);
			return () => closeCbs.delete(cb);
		},

		close: shutdown
	};
}
