/**
 * NTP-style clock offset estimation (PLAN.md 7, Phase 3).
 *
 * Guest sends ping{t0}, host replies pong{t0,t1}, guest receives at t2:
 *
 *   rtt    = t2 - t0
 *   offset = t1 - (t0 + t2) / 2
 *
 * The offset formula assumes the two legs of the round trip took the same time.
 * They never do, and the error is bounded by rtt/2, which is why we keep a
 * window and select on minimum RTT rather than averaging (see `minRtt`).
 *
 * Only the guest runs a ClockSync. The host is the clock; it has no offset to
 * estimate and answers pongs statelessly.
 */

import type { Ping, Pong } from '$lib/protocol/control';

export const PING_INTERVAL_MS = 2000;

/** Sliding window size. 16 samples at 2s covers ~30s of network conditions. */
export const WINDOW_SIZE = 16;

/** A ping older than this lost its pong. Bounds `pending` without a second timer. */
const PING_TIMEOUT_MS = 10_000;

/**
 * The one time base for the whole sync engine.
 *
 * Epoch milliseconds, same domain as Date.now(), but built from the monotonic
 * clock: `timeOrigin` is fixed at page load and `now()` never steps. Date.now()
 * jumps whenever the OS disciplines its clock, and a 200ms NTP step landing
 * between two of these subtractions is indistinguishable from a 200ms drift --
 * so it would silently corrupt an offset sample, or make the guest hard-seek for
 * no reason.
 *
 * Every timestamp that crosses the wire -- ping.t0, pong.t1, state.atHostClock
 * -- is this function, on both machines. Nothing in the sync engine calls
 * Date.now(), and nothing subtracts a performance.now() from an epoch value.
 * Sub-millisecond resolution is a bonus; consistency is the point.
 */
export function nowMs(): number {
	return performance.timeOrigin + performance.now();
}

type Sample = { rtt: number; offset: number };

/**
 * The least queue-distorted sample in the window, not the mean.
 *
 * Queueing only ever adds delay, and it adds it asymmetrically, so a slow round
 * trip is evidence of a *biased* offset rather than a noisy one. The fastest
 * round trip is the one that spent the least time in a queue, so its offset is
 * the closest to true. Averaging mixes the good sample back into the bad ones.
 */
function minRtt(window: readonly Sample[]): Sample | null {
	let best: Sample | null = null;
	for (const s of window) {
		if (!best || s.rtt < best.rtt) best = s;
	}
	return best;
}

export class ClockSync {
	private readonly send: (msg: Ping) => void;
	private readonly window: Sample[] = [];
	private best: Sample | null = null;
	/** t0 of each ping still awaiting a pong. A pong we cannot match is ignored. */
	private readonly pending = new Set<number>();
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(send: (msg: Ping) => void) {
		this.send = send;
	}

	/** Add to our clock to get the host's. Zero until the first pong lands. */
	get offset(): number {
		return this.best ? this.best.offset : 0;
	}

	/** The rtt of the sample the offset came from, not the latest rtt. */
	get rtt(): number {
		return this.best ? this.best.rtt : 0;
	}

	get samples(): number {
		return this.window.length;
	}

	/**
	 * The host's clock, now. Before the first pong this is our own clock, which
	 * is the honest answer: check `samples` if you need to know whether it means
	 * anything yet.
	 */
	hostNow(): number {
		return nowMs() + this.offset;
	}

	start(): void {
		if (this.timer !== null) return;
		this.ping();
		this.timer = setInterval(() => this.ping(), PING_INTERVAL_MS);
	}

	stop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.pending.clear();
	}

	/**
	 * `receivedAt` must come from nowMs(). Pass the channel's own arrival
	 * timestamp when you have one: any delay between arrival and this call
	 * inflates rtt and biases offset by half of it.
	 */
	onPong(msg: Pong, receivedAt: number = nowMs()): void {
		// Only accept t0 values we actually sent, so a duplicate or fabricated
		// pong cannot inject a sample.
		if (!this.pending.delete(msg.t0)) return;
		if (!Number.isFinite(msg.t1)) return;

		const rtt = receivedAt - msg.t0;
		if (!Number.isFinite(rtt) || rtt < 0) return;

		this.window.push({ rtt, offset: msg.t1 - (msg.t0 + receivedAt) / 2 });
		if (this.window.length > WINDOW_SIZE) this.window.shift();
		this.best = minRtt(this.window);
	}

	private ping(): void {
		const t0 = nowMs();
		for (const sent of this.pending) {
			if (t0 - sent > PING_TIMEOUT_MS) this.pending.delete(sent);
		}
		this.pending.add(t0);
		this.send({ t: 'ping', t0 });
	}
}
