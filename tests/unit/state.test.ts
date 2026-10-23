import { afterEach, describe, expect, test } from 'bun:test';
import type { State } from '$lib/protocol/control';
import { ClockSync, nowMs } from '$lib/sync/clock';
import {
	BARRIER_HIGH_SEC,
	BARRIER_LOW_SEC,
	GuestSync,
	HARD_SEEK_SEC,
	HostState,
	ReadinessBarrier,
	type BlockedPeer
} from '$lib/sync/state';
import { fakeVideo } from './fake-video';

describe('HostState.snapshot (REVIEW F-14)', () => {
	test('a buffering host is not "playing": the room must not extrapolate past it', () => {
		const video = fakeVideo();
		const sent: State[] = [];
		const host = new HostState(video, (s) => sent.push(s));
		video.paused = false;
		video.readyState = 4;
		expect(host.snapshot().playing).toBe(true);
		video.readyState = 2; // HAVE_CURRENT_DATA: stalled
		expect(host.snapshot().playing).toBe(false);
		video.readyState = 3;
		expect(host.snapshot().playing).toBe(true);
	});

	test('seq is monotonic across snapshots and `waiting` re-anchors', () => {
		const video = fakeVideo();
		const sent: State[] = [];
		const host = new HostState(video, (s) => sent.push(s));
		host.start();
		const before = sent.length;
		video.fire('waiting');
		expect(sent.length).toBe(before + 1);
		expect(sent.map((s) => s.seq)).toEqual([...sent.map((s) => s.seq)].sort((a, b) => a - b));
		host.stop();
	});

	test('the lead-in is applied on the way out and the way in', () => {
		const video = fakeVideo();
		const host = new HostState(video, () => {});
		host.setLeadIn(2);
		video.currentTime = 10;
		expect(host.snapshot().mediaTime).toBe(12);
		host.applyIntent({ t: 'intent', action: 'seek', mediaTime: 20 });
		expect(video.currentTime).toBe(18);
	});
});

/** A clock with one sample, so extrapolation is live and the offset is zero. */
function measuredClock(): ClockSync {
	let t0 = 0;
	const clock = new ClockSync((ping) => (t0 = ping.t0));
	clock.start();
	// Before stop(): stopping forgets the pings still awaiting a pong.
	clock.onPong({ t: 'pong', t0, t1: t0 }, t0);
	clock.stop();
	expect(clock.samples).toBe(1);
	return clock;
}

const state = (over: Partial<State>): State => ({
	t: 'state',
	playing: true,
	mediaTime: 0,
	atHostClock: nowMs(),
	seq: 1,
	...over
});

describe('GuestSync', () => {
	test('REVIEW F-15: an authoritative pause is honoured while a seek is still in flight', () => {
		const video = fakeVideo();
		const sync = new GuestSync(video, measuredClock());
		video.paused = false;
		video.currentTime = 20;
		video.seeking = true;
		sync.apply(state({ playing: false, mediaTime: 20, seq: 2 }));
		expect(video.paused).toBe(true);
	});

	test('REVIEW F-15: a newer seek supersedes one in flight; drift during the seek does not', () => {
		const video = fakeVideo();
		const sync = new GuestSync(video, measuredClock());
		// A far seek the host announced at t=100.
		video.currentTime = 10;
		video.seeks.length = 0;
		sync.apply(state({ playing: true, mediaTime: 100, seq: 1 }));
		// Extrapolated by the microseconds since the message, hence the rounding.
		expect(video.seeks.map(Math.round)).toEqual([100]);
		video.seeking = true;
		// The host's heartbeat a moment later: same seek, advanced by elapsed time.
		const t = nowMs();
		sync.apply(state({ playing: true, mediaTime: 100 + 0.2, atHostClock: t + 200, seq: 2 }));
		expect(video.seeks.map(Math.round)).toEqual([100]);
		// The host seeks somewhere else entirely while we are still landing.
		sync.apply(state({ playing: true, mediaTime: 300, atHostClock: t + 300, seq: 3 }));
		expect(video.seeks.map(Math.round)).toEqual([100, 300]);
	});

	test('hard seek above the threshold, rate nudge below it', () => {
		const video = fakeVideo();
		const sync = new GuestSync(video, measuredClock());
		sync.apply(state({ mediaTime: HARD_SEEK_SEC + 1, seq: 1 }));
		expect(video.seeks.length).toBe(1);
		video.currentTime = 10;
		video.seeks.length = 0;
		video.paused = false;
		sync.apply(state({ mediaTime: 10.2, seq: 2 }));
		expect(video.playbackRate).toBeGreaterThan(1);
		expect(video.playbackRate).toBeLessThanOrEqual(1.05);
	});

	test('a stale or duplicate seq is ignored', () => {
		const video = fakeVideo();
		const sync = new GuestSync(video, measuredClock());
		sync.apply(state({ mediaTime: 50, seq: 5 }));
		sync.apply(state({ mediaTime: 90, seq: 5 }));
		sync.apply(state({ mediaTime: 90, seq: 4 }));
		expect(video.seeks.map(Math.round)).toEqual([50]);
	});
});

describe('ReadinessBarrier', () => {
	let barrier: ReadinessBarrier | null = null;
	afterEach(() => barrier?.stop());

	function make() {
		const pauses: BlockedPeer[][] = [];
		let resumes = 0;
		barrier = new ReadinessBarrier({
			onPause: (on) => pauses.push(on),
			onResume: () => resumes++
		});
		return { barrier, pauses, resumes: () => resumes };
	}

	test('trips below the low watermark, clears above the high one, with hysteresis', () => {
		const { barrier, pauses, resumes } = make();
		barrier.report('a', 'Ann', BARRIER_LOW_SEC - 0.5);
		expect(pauses).toEqual([[{ peerId: 'a', name: 'Ann' }]]);
		barrier.report('a', 'Ann', (BARRIER_LOW_SEC + BARRIER_HIGH_SEC) / 2);
		expect(resumes()).toBe(0);
		barrier.report('a', 'Ann', BARRIER_HIGH_SEC + 1);
		expect(resumes()).toBe(1);
	});

	test('REVIEW F-02: an end-ready guest never blocks, however little is left', () => {
		const { barrier, pauses } = make();
		barrier.report('a', 'Ann', 0.3, true);
		expect(pauses).toEqual([]);
		expect(barrier.waitingOn).toEqual([]);
	});

	test('NaN is not evidence: it keeps the last verdict and proves liveness', () => {
		const { barrier, pauses } = make();
		barrier.report('a', 'Ann', 0);
		barrier.report('a', 'Ann', NaN);
		expect(pauses.length).toBe(1);
		expect(barrier.waitingOn.map((p) => p.peerId)).toEqual(['a']);
	});

	test('REVIEW F-17: rearm after an override does not re-pause on pre-seek evidence', () => {
		const { barrier, pauses } = make();
		barrier.report('a', 'Ann', 0);
		expect(pauses.length).toBe(1);
		expect(barrier.override()).toBe(true);
		expect(barrier.waitingOn).toEqual([]);
		barrier.rearm();
		expect(pauses.length).toBe(1);
		// The next report decides.
		barrier.report('a', 'Ann', 0);
		expect(pauses.length).toBe(2);
	});

	test('REVIEW F-08: a removed guest stops holding the room', () => {
		const { barrier, resumes } = make();
		barrier.report('a', 'Ann', 0);
		barrier.remove('a');
		expect(resumes()).toBe(1);
		expect(barrier.waitingOn).toEqual([]);
	});

	test('disabling lifts the hold; re-enabling evaluates again', () => {
		const { barrier, resumes, pauses } = make();
		barrier.report('a', 'Ann', 0);
		barrier.setEnabled(false);
		expect(resumes()).toBe(1);
		barrier.setEnabled(true);
		expect(pauses.length).toBe(2);
	});
});
