import { expect, test, type Page } from '@playwright/test';
import { openGuest, openHost, snapshot, until } from './helpers';

/** The picture on screen, as grey levels at a quarter of the film's size. */
const frame = (page: Page): Promise<number[]> =>
	page.evaluate(() => {
		const video = document.querySelector('video') as HTMLVideoElement;
		const canvas = document.createElement('canvas');
		canvas.width = 480;
		canvas.height = 270;
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
		const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
		const grey: number[] = [];
		for (let i = 0; i < data.length; i += 4) grey.push((data[i] + data[i + 1] + data[i + 2]) / 3);
		return grey;
	});

/**
 * The share of the picture that visibly changed between two frames.
 *
 * Counted rather than averaged: the fixture is a test card where most of the
 * frame never moves, so a mean is dominated by the part that says nothing. The
 * threshold is well past what two decodes of one frame differ by, and well
 * under what a moved edge does.
 */
const difference = (a: number[], b: number[]) =>
	a.filter((v, i) => Math.abs(v - b[i]) > 32).length / a.length;

const settledAt = (page: Page, t: number) =>
	until(
		() =>
			page.evaluate(() => {
				const v = document.querySelector('video') as HTMLVideoElement;
				return { time: v.currentTime, seeking: v.seeking, readyState: v.readyState };
			}),
		(v) => Math.abs(v.time - t) < 0.02 && !v.seeking && v.readyState >= 2,
		{ what: `a frame at ${t}s`, timeout: 30_000 }
	);

/**
 * A file trimmed without re-encoding keeps every sample and records the trim
 * as an edit list: "start one second in". The host's <video> plays the file
 * off disk and honours that. The stream guests get was cut from the raw sample
 * times and did not, so the two ends disagreed about which moment of the film
 * a reading of the clock meant - and about how long the film was, which left
 * holes in what the guest's player thought it had buffered.
 *
 * edit-list.mp4 is tiny-60s.mp4 cut at 5s by stream copy, which lands the cut
 * a second into a GOP. That second is the interesting part: the frame the edit
 * starts on cannot be decoded without the keyframe before it, so the stream
 * has to start a second earlier than the host does, and the room's clock
 * carries the difference (`Origin.leadInSec`). A guest therefore reads a
 * second more than the host, at the same frame.
 */
test('a film trimmed with an edit list shows host and guest the same frame', async ({
	page,
	context
}) => {
	const { code } = await openHost(page, 'edit-list.mp4');
	const { page: guest } = await openGuest(context, code);
	await until(
		() => snapshot(guest),
		(s) => s.ttff !== null,
		{ what: 'first frame', timeout: 60_000 }
	);

	// Read before anything seeks, since a seek far enough ahead lets the player
	// drop what it had. Nothing of the film is missing from the front of the guest's copy. A stream
	// that starts on the edit instead of on its keyframe loses the whole first
	// GOP, and the guest's picture begins a second or more after the host's.
	const start = await guest.evaluate(() => {
		const v = document.querySelector('video') as HTMLVideoElement;
		return v.buffered.length > 0 ? v.buffered.start(0) : -1;
	});
	expect(start, "the guest's film must be buffered from its first frame").toBeGreaterThanOrEqual(0);
	expect(start).toBeLessThan(0.1);

	const durationOf = (p: Page) =>
		p.evaluate(() => (document.querySelector('video') as HTMLVideoElement).duration);
	const lead = (await durationOf(guest)) - (await durationOf(page));
	expect(
		lead,
		"the stream starts at the keyframe a second before the host's first frame"
	).toBeGreaterThan(0.9);
	expect(lead).toBeLessThan(1.1);

	await page.getByTestId('seek').fill('8');
	await page.getByTestId('seek').dispatchEvent('change');
	await settledAt(page, 8);
	await settledAt(guest, 8 + lead);
	// Paused, so the guest holds this frame still for as long as it takes to read.
	const guestFrame = await frame(guest);

	/** The host's own picture at `t`, set on the element directly. */
	const hostFrameAt = async (t: number) => {
		await page.evaluate((to) => {
			(document.querySelector('video') as HTMLVideoElement).currentTime = to;
		}, t);
		await settledAt(page, t);
		return frame(page);
	};

	// 8s is a frame boundary at 30fps, as every position the seek bar can reach
	// is, and which side of a boundary a decoder lands on is rounding. So the
	// claim is "one of the two frames that meet at 8s", each read from its
	// middle - not the frame a whole trim away, which is what this used to show.
	const HALF_FRAME = 1 / 60;
	const before = await hostFrameAt(8 - HALF_FRAME);
	const after = await hostFrameAt(8 + HALF_FRAME);

	// The control: what the oracle reads across the size of error being ruled
	// out, the fixture's ~1.07s edit.
	const apart = difference(after, await hostFrameAt(8 + 1.0667));
	expect(apart, 'frames a trim apart must look different to this oracle').toBeGreaterThan(0.01);

	const nearest = Math.min(difference(before, guestFrame), difference(after, guestFrame));
	expect(
		nearest,
		`host and guest at 8s must be the same frame (frames a trim apart differ over ${(apart * 100).toFixed(1)}% of the picture)`
	).toBeLessThan(apart / 4);
});
