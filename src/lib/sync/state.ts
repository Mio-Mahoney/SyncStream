/**
 * The sync engine (PLAN.md 7, Phase 3).
 *
 * One rule underneath all of it: the host is the authority and it broadcasts
 * *absolute* state, never a relative toggle. `video.paused ? 'play' : 'pause'`
 * derived from whoever clicked is not idempotent, so it desyncs the moment two
 * messages race, and it cannot be re-sent to a late joiner. Absolute state can
 * be dropped, duplicated, reordered, or replayed and still converge.
 *
 * Guests send intent, apply state, and correct themselves. They never send
 * state to each other and never command the host.
 *
 * UNITS. mediaTime and currentTime are SECONDS. atHostClock and hostNow() are
 * MILLISECONDS in the nowMs() domain. The only place they meet is the target
 * calculation, and getting that conversion wrong is a 1000x error.
 */

import type { Intent, State } from '$lib/protocol/control';
import { ClockSync, nowMs } from '$lib/sync/clock';

export const HEARTBEAT_MS = 1000;
export const CORRECT_MS = 250;

/** Below this the error is not worth touching playback for. */
export const DEADBAND_SEC = 0.05;

/** Max rate deviation. 5% is under the ~6% where pitch shift becomes audible. */
export const MAX_NUDGE = 0.05;

/** At or above this, rate correction would take >10s. Take the visible seek. */
export const HARD_SEEK_SEC = 0.5;

/** Buffer depth that trips the barrier, and the deeper one that clears it. */
export const BARRIER_LOW_SEC = 1;
export const BARRIER_HIGH_SEC = 5;

/** A guest that has not reported in this long is treated as gone, not as stalled. */
export const BARRIER_STALE_MS = 5000;

/** HTMLMediaElement.HAVE_METADATA, without touching the global in a test env. */
const HAVE_METADATA = 1;

function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

function isState(s: State): boolean {
	return (
		typeof s.playing === 'boolean' &&
		Number.isFinite(s.mediaTime) &&
		Number.isFinite(s.atHostClock) &&
		Number.isFinite(s.seq)
	);
}

/**
 * Clamps a seek target to the media. `duration` is NaN until metadata loads, so
 * an unclamped upper bound is the correct answer then, not zero.
 */
function clampToMedia(video: HTMLMediaElement, t: number): number {
	const d = video.duration;
	return clamp(t, 0, Number.isFinite(d) ? d : Infinity);
}

/**
 * Events that change what an anchor means. `playing` is in the set because it
 * marks the end of a host-side stall: currentTime froze while the wall clock did
 * not, so guests have been extrapolating past the host and need a fresh anchor
 * the instant it recovers rather than at the next heartbeat.
 */
const ANCHOR_EVENTS = ['play', 'pause', 'seeked', 'playing'] as const;

export class HostState {
	private readonly video: HTMLMediaElement;
	private readonly broadcast: (s: State) => void;
	private readonly onAnchor = () => this.emit();
	private seq = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	/** True only when *we* stopped playback, which is what makes resume() safe. */
	private autoPaused = false;
	private reason: string | null = null;

	constructor(video: HTMLMediaElement, broadcast: (s: State) => void) {
		this.video = video;
		this.broadcast = broadcast;
	}

	/** Why the barrier stopped the room, for the host's own UI. */
	get pauseReason(): string | null {
		return this.reason;
	}

	start(): void {
		if (this.timer !== null) return;
		for (const e of ANCHOR_EVENTS) this.video.addEventListener(e, this.onAnchor);
		// The heartbeat is not just liveness: it re-anchors mediaTime against the
		// host clock every second, so a guest's extrapolation error can never
		// accumulate for longer than that.
		this.timer = setInterval(() => this.emit(), HEARTBEAT_MS);
		this.emit();
	}

	stop(): void {
		for (const e of ANCHOR_EVENTS) this.video.removeEventListener(e, this.onAnchor);
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * The current truth as a sendable message.
	 *
	 * Mints a new seq on every call, so the result is always safe to hand to
	 * anyone -- including a guest that reconnected and whose GuestSync has
	 * already seen a higher seq. This is a message factory, not a UI read.
	 */
	snapshot(): State {
		return {
			t: 'state',
			playing: !this.video.paused,
			mediaTime: this.video.currentTime,
			atHostClock: nowMs(),
			seq: ++this.seq
		};
	}

	/**
	 * A guest asked; the host decides. Note that mediaTime is honoured only for a
	 * seek: a guest's playhead is a follower's estimate, so letting play/pause
	 * carry it would let a lagging guest drag the room's position backwards.
	 */
	applyIntent(i: Intent): void {
		switch (i.action) {
			case 'play':
				// An explicit play overrides the barrier's brake; it must not be
				// undone by a later resume().
				this.autoPaused = false;
				this.reason = null;
				this.play();
				break;
			case 'pause':
				this.autoPaused = false;
				this.video.pause();
				break;
			case 'seek':
				if (!Number.isFinite(i.mediaTime)) return;
				this.video.currentTime = clampToMedia(this.video, i.mediaTime);
				break;
			default:
				return;
		}
		// A seek only fires `seeked` once it completes, which can be hundreds of
		// ms. Emit now so the room moves together, and again when it lands.
		this.emit();
	}

	/**
	 * The readiness barrier's brake. Only a pause that actually stopped playback
	 * is resumable: if the host had already paused deliberately, the barrier
	 * lifting must not start the movie behind their back.
	 */
	pause(reason?: string): void {
		this.reason = reason ?? null;
		if (this.video.paused) return;
		this.autoPaused = true;
		this.video.pause();
		this.emit();
	}

	resume(): void {
		this.reason = null;
		if (!this.autoPaused) return;
		this.autoPaused = false;
		this.play();
		this.emit();
	}

	private play(): void {
		// Rejects under the autoplay policy until the host has interacted with the
		// page. The `pause` event that follows re-broadcasts the true state, so
		// there is nothing to do here but not throw.
		void this.video.play().catch(() => undefined);
	}

	private emit(): void {
		this.broadcast(this.snapshot());
	}
}

export class GuestSync {
	private readonly video: HTMLMediaElement;
	private readonly clock: ClockSync;
	private timer: ReturnType<typeof setInterval> | null = null;
	private state: State | null = null;
	private err = 0;
	private playPending = false;

	constructor(video: HTMLMediaElement, clock: ClockSync) {
		this.video = video;
		this.clock = clock;
	}

	/** Last measured error in seconds, signed: positive means we are behind. */
	get drift(): number {
		return this.err;
	}

	get lastState(): State | null {
		return this.state;
	}

	start(): void {
		if (this.timer !== null) return;
		this.timer = setInterval(() => this.correct(), CORRECT_MS);
		this.correct();
	}

	stop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		// Never leave a nudge on an element we no longer steer.
		this.setRate(1);
	}

	apply(s: State): void {
		if (!isState(s)) return;
		// Equal seq is a duplicate, not new information: the host mints seq and
		// atHostClock together, so re-applying it would anchor to a stale reading.
		if (this.state && s.seq <= this.state.seq) return;
		this.state = s;
		this.correct();
	}

	private correct(): void {
		const s = this.state;
		if (!s) return;
		// currentTime already reads as the target of an in-flight seek, so
		// measuring now would stack a second seek on top of the first, and the
		// error is meaningless before metadata exists.
		if (this.video.seeking || this.video.readyState < HAVE_METADATA) return;

		// Extrapolating against atHostClock needs a *measured* offset. Until the
		// first pong lands ClockSync reports 0, so hostNow() is our own clock --
		// and two machines' epoch clocks routinely differ by seconds or minutes.
		// `elapsed` would then be that skew, and the hard-seek branch would obey
		// it and jump us somewhere arbitrary (and make Shaka fetch the segments
		// to match) before the pong arrives to undo it. This is the normal path
		// through a join, not a corner: the host pushes state on channel open,
		// while the first pong is a full round trip behind it. Honour play/pause
		// and leave the playhead alone for that one RTT. A paused state does not
		// extrapolate, so it is unaffected.
		if (s.playing && this.clock.samples === 0) {
			this.follow(s);
			return;
		}

		// The one place seconds and milliseconds meet. atHostClock and hostNow()
		// are ms; mediaTime and currentTime are seconds.
		const elapsedSec = (this.clock.hostNow() - s.atHostClock) / 1000;
		const target = s.playing ? s.mediaTime + elapsedSec : s.mediaTime;
		const err = target - this.video.currentTime;
		this.err = err;

		this.follow(s);

		const mag = Math.abs(err);
		if (mag >= HARD_SEEK_SEC) {
			this.setRate(1);
			this.video.currentTime = clampToMedia(this.video, target);
		} else if (s.playing && mag >= DEADBAND_SEC) {
			// Converges a 0.5s error in 10s, inaudibly. Sign follows err: behind
			// (err > 0) means speed up.
			this.setRate(1 + clamp(err, -MAX_NUDGE, MAX_NUDGE));
		} else {
			// A rate nudge does nothing to a paused element, and would then apply
			// itself to the first moments of the next play. Keep it at 1.
			this.setRate(1);
		}
	}

	/**
	 * Re-asserts the host's play/pause every tick rather than only on change: a
	 * guest's play() can be refused by the autoplay policy, and re-asserting is
	 * what makes the room recover the instant the user touches the page.
	 */
	private follow(s: State): void {
		if (!s.playing) {
			if (!this.video.paused) this.video.pause();
			return;
		}
		if (!this.video.paused || this.video.ended || this.playPending) return;
		this.playPending = true;
		void this.video
			.play()
			.catch(() => undefined)
			.finally(() => {
				this.playPending = false;
			});
	}

	private setRate(rate: number): void {
		// Assigning fires ratechange; skip the no-op writes the deadband produces
		// four times a second.
		if (Math.abs(this.video.playbackRate - rate) < 1e-4) return;
		this.video.playbackRate = rate;
	}
}

type PeerHealth = { name: string; blocking: boolean; at: number };

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Auto-pauses the room while any guest is running out of buffer, so a slow guest
 * is visible instead of silently desynced (PLAN.md 7, Phase 3).
 *
 * The 1s/5s gap is hysteresis, not sloppiness. A single threshold would trip and
 * clear on every jitter of one guest's buffer, and each transition is a pause and
 * a resume for everyone: the flapping would be worse than the stall it fixes.
 */
export class ReadinessBarrier {
	private readonly onPause: (waitingOn: string[]) => void;
	private readonly onResume: () => void;
	private readonly peers = new Map<string, PeerHealth>();
	private enabled: boolean;
	private engaged = false;
	private announced: string[] = [];
	private timer: ReturnType<typeof setInterval> | null;

	constructor(opts: {
		onPause: (waitingOn: string[]) => void;
		onResume: () => void;
		enabled?: boolean;
	}) {
		this.onPause = opts.onPause;
		this.onResume = opts.onResume;
		this.enabled = opts.enabled ?? true;
		// A guest that goes silent while blocking would otherwise hold the room
		// paused until the transport notices it left, which is an ICE timeout away.
		// Nothing else ticks here, so the sweep needs its own timer.
		this.timer = setInterval(() => this.sweep(), HEARTBEAT_MS);
	}

	/** Display names of the guests currently blocking the room. */
	get waitingOn(): string[] {
		if (!this.enabled) return [];
		const now = nowMs();
		const out: string[] = [];
		for (const p of this.peers.values()) {
			if (p.blocking && now - p.at <= BARRIER_STALE_MS) out.push(p.name);
		}
		return out;
	}

	report(peerId: string, name: string, bufferedAhead: number): void {
		const now = nowMs();
		let p = this.peers.get(peerId);
		if (!p) {
			p = { name: name || peerId, blocking: false, at: now };
			this.peers.set(peerId, p);
		}
		p.name = name || peerId;
		p.at = now;

		// A player that has not built a buffer range yet reports NaN. That is not
		// evidence either way, so keep the peer's last verdict instead of
		// inventing one -- but the report still proves it is alive.
		if (Number.isFinite(bufferedAhead)) {
			if (p.blocking) {
				if (bufferedAhead > BARRIER_HIGH_SEC) p.blocking = false;
			} else if (bufferedAhead < BARRIER_LOW_SEC) {
				p.blocking = true;
			}
		}
		this.evaluate();
	}

	remove(peerId: string): void {
		if (this.peers.delete(peerId)) this.evaluate();
	}

	setEnabled(v: boolean): void {
		if (v === this.enabled) return;
		this.enabled = v;
		this.evaluate();
	}

	/** Releases the staleness sweep. Not in the Phase 3 spec; a timer needs an owner. */
	stop(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private sweep(): void {
		const now = nowMs();
		let changed = false;
		for (const [id, p] of this.peers) {
			if (now - p.at > BARRIER_STALE_MS) {
				this.peers.delete(id);
				changed = true;
			}
		}
		if (changed) this.evaluate();
	}

	private evaluate(): void {
		const on = this.waitingOn;
		if (on.length === 0) {
			if (!this.engaged) return;
			this.engaged = false;
			this.announced = [];
			this.onResume();
			return;
		}
		// Re-fire while engaged when the list itself changes, so "Waiting for
		// Jamie" becomes "Waiting for Sam" rather than going stale.
		if (this.engaged && sameList(on, this.announced)) return;
		this.engaged = true;
		this.announced = on;
		this.onPause([...on]);
	}
}
