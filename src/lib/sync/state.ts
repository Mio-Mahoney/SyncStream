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
/** HTMLMediaElement.HAVE_FUTURE_DATA: enough buffered that the element is advancing. */
const HAVE_FUTURE_DATA = 3;

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
 * the instant it recovers rather than at the next heartbeat. `waiting` is its
 * mirror, the start of that stall: the snapshot reads the element as not
 * advancing (see `snapshot`), and the room has to hear that at once rather
 * than extrapolate a second further on the heartbeat.
 */
const ANCHOR_EVENTS = ['play', 'pause', 'seeked', 'playing', 'waiting'] as const;

export class HostState {
	private readonly video: HTMLMediaElement;
	private readonly broadcast: (s: State) => void;
	private readonly onAnchor = () => this.emit();
	private seq = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	/** True only when *we* stopped playback, which is what makes resume() safe. */
	private autoPaused = false;
	private leadIn = 0;

	constructor(video: HTMLMediaElement, broadcast: (s: State) => void) {
		this.video = video;
		this.broadcast = broadcast;
	}

	/**
	 * How far the room's clock runs ahead of this element's, in seconds.
	 *
	 * `mediaTime` on the wire is a position in the stream guests play. A host
	 * playing the file straight off disk is on the file's own timeline, which
	 * starts later than the stream's by the stream's lead-in
	 * (`Origin.leadInSec`), so every time that crosses the wire is converted
	 * here, in both directions. Zero when the host plays the stream itself.
	 */
	get leadInSec(): number {
		return this.leadIn;
	}

	setLeadIn(seconds: number): void {
		this.leadIn = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
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
			// Advancing, not merely unpaused. A host whose element is buffering
			// (slow disk, an encoder behind on a tier-2 film) is `paused === false`
			// at a frozen currentTime, and a heartbeat saying "playing, at 100.0"
			// every second had guests extrapolate to 101, hard-seek back to 100,
			// and do it again a second later for as long as the stall ran. While
			// the host is not moving, nobody should be.
			playing: !this.video.paused && this.video.readyState >= HAVE_FUTURE_DATA,
			mediaTime: this.video.currentTime + this.leadIn,
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
				this.play();
				break;
			case 'pause':
				this.autoPaused = false;
				this.video.pause();
				break;
			case 'seek':
				if (!Number.isFinite(i.mediaTime)) return;
				this.video.currentTime = clampToMedia(this.video, i.mediaTime - this.leadIn);
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
	pause(): void {
		if (this.video.paused) return;
		this.autoPaused = true;
		this.video.pause();
		this.emit();
	}

	resume(): void {
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

	/**
	 * Forget the host we were following. `seq` is minted per host page, so a new
	 * page starts again at 1, and without this every state it sent would lose to
	 * the last one its predecessor did for as long as that predecessor ran.
	 */
	reset(): void {
		this.state = null;
		this.seekFrom = null;
		this.err = 0;
	}

	apply(s: State): void {
		if (!isState(s)) return;
		// Equal seq is a duplicate, not new information: the host mints seq and
		// atHostClock together, so re-applying it would anchor to a stale reading.
		if (this.state && s.seq <= this.state.seq) return;
		this.state = s;
		this.correct();
	}

	/**
	 * The state whose hard seek is in flight, so a seek that lands while the
	 * element is still seeking can be told apart from drift measured against a
	 * target the element already reads as current.
	 */
	private seekFrom: State | null = null;

	private correct(): void {
		const s = this.state;
		if (!s) return;
		// Play and pause are honoured before anything that could defer them. The
		// seeking guard below used to sit in front of this, and a seek whose
		// target the host was slow to serve (a cold rung, a far corner of the
		// file) held every later state back for as long as the fetch took - an
		// authoritative pause included, so the room stopped and this element
		// played on for up to a minute. Nothing about play/pause depends on the
		// playhead being settled.
		if (this.video.readyState < HAVE_METADATA) return;
		this.follow(s);

		// currentTime already reads as the target of an in-flight seek, so
		// measuring against it would stack a second seek on top of the first.
		// Only a *different* seek may interrupt one: the host moved again, which
		// shows as the state's own position jumping away from where the one we
		// are seeking for said it would be by now.
		if (this.video.seeking) {
			if (this.seekFrom && this.supersedes(s, this.seekFrom)) {
				this.seekFrom = s;
				this.video.currentTime = clampToMedia(this.video, this.targetOf(s));
			}
			return;
		}
		this.seekFrom = null;

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
		if (s.playing && this.clock.samples === 0) return;

		const target = this.targetOf(s);
		const err = target - this.video.currentTime;
		this.err = err;

		const mag = Math.abs(err);
		if (mag >= HARD_SEEK_SEC) {
			this.setRate(1);
			this.seekFrom = s;
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
	 * Where the host is now, per `s`. The one place seconds and milliseconds
	 * meet: atHostClock and hostNow() are ms; mediaTime and currentTime are
	 * seconds.
	 */
	private targetOf(s: State): number {
		const elapsedSec = (this.clock.hostNow() - s.atHostClock) / 1000;
		return s.playing ? s.mediaTime + elapsedSec : s.mediaTime;
	}

	/**
	 * Whether `next` describes a new seek rather than `from` a moment later. The
	 * host's heartbeat advances mediaTime with playback, so the comparison is
	 * against where `from` predicts the host would be at `next`'s clock reading,
	 * and only a jump wider than the hard-seek threshold counts.
	 */
	private supersedes(next: State, from: State): boolean {
		if (next === from) return false;
		const elapsedSec = from.playing ? (next.atHostClock - from.atHostClock) / 1000 : 0;
		const predicted = from.mediaTime + elapsedSec;
		return Math.abs(next.mediaTime - predicted) >= HARD_SEEK_SEC;
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

/**
 * A guest the barrier is holding the room for, carrying both of its identities.
 *
 * The name is what a sentence about this guest needs; the id is what deciding
 * who to say that sentence to needs. This used to report only the name, which
 * left the caller with a list it could not attribute - and the caller then fed
 * those names back into a map keyed by id, so every lookup missed and every
 * banner in the app read "Waiting for a guest" no matter who it was waiting for.
 */
export type BlockedPeer = { peerId: string; name: string };

function samePeers(a: readonly BlockedPeer[], b: readonly BlockedPeer[]): boolean {
	return (
		a.length === b.length && a.every((v, i) => v.peerId === b[i].peerId && v.name === b[i].name)
	);
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
	private readonly onPause: (waitingOn: BlockedPeer[]) => void;
	private readonly onResume: () => void;
	private readonly peers = new Map<string, PeerHealth>();
	private enabled: boolean;
	private engaged = false;
	/** Someone played through the current hold; see `override`. */
	private overridden = false;
	private announced: BlockedPeer[] = [];
	private timer: ReturnType<typeof setInterval> | null;

	constructor(opts: {
		onPause: (waitingOn: BlockedPeer[]) => void;
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

	/** The guests the room is being held for. Nobody, once the hold was overridden. */
	get waitingOn(): BlockedPeer[] {
		return this.overridden ? [] : this.blocking();
	}

	/**
	 * An explicit play through the hold. The room stops waiting, and stays that
	 * way until everyone has caught up or the room seeks (`rearm`): re-engaging
	 * on the next status tick would pause the film a second after someone
	 * deliberately started it.
	 *
	 * Returns whether there was a hold to override, so the caller knows whether
	 * a banner needs taking down.
	 */
	override(): boolean {
		if (!this.engaged || this.overridden) return false;
		this.overridden = true;
		this.announced = [];
		return true;
	}

	/**
	 * A seek ends whatever an override forgave. The override was a decision
	 * about the stall on screen when somebody pressed play; a seek puts the
	 * whole room somewhere nobody has loaded yet, and a guest who cannot keep
	 * up there is a new stall, not the old one. Holding the override through it
	 * let the film run on with a guest silently left behind - a room started
	 * during its opening hold and then seeked never waited for anyone again.
	 */
	rearm(): void {
		if (!this.overridden) return;
		this.overridden = false;
		// Every verdict on file is about buffers at the position the room just
		// left. Evaluating them here re-paused the room at the instant of the
		// seek on a straggler's last pre-seek report, before anyone had loaded a
		// frame of the new position. The next report from each guest decides;
		// until then nobody is blocking, which `evaluate` reads as a resume for a
		// hold the override had already lifted - a no-op.
		for (const p of this.peers.values()) p.blocking = false;
		this.evaluate();
	}

	private blocking(): BlockedPeer[] {
		if (!this.enabled) return [];
		const now = nowMs();
		const out: BlockedPeer[] = [];
		for (const [peerId, p] of this.peers) {
			if (p.blocking && now - p.at <= BARRIER_STALE_MS) out.push({ peerId, name: p.name });
		}
		return out;
	}

	/** End-ready peers cannot refill above the high watermark and need no hold. */
	report(peerId: string, name: string, bufferedAhead: number, atEnd = false): void {
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
		if (atEnd) {
			p.blocking = false;
		} else if (Number.isFinite(bufferedAhead)) {
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
		const on = this.blocking();
		if (on.length === 0) {
			if (!this.engaged) return;
			this.engaged = false;
			this.overridden = false;
			this.announced = [];
			this.onResume();
			return;
		}
		if (this.overridden) return;
		// Re-fire while engaged when the list itself changes, so "Waiting for
		// Jamie" becomes "Waiting for Sam" rather than going stale.
		if (this.engaged && samePeers(on, this.announced)) return;
		this.engaged = true;
		this.announced = on;
		this.onPause([...on]);
	}
}
