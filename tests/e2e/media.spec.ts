import { expect, test } from '@playwright/test';
import { fixture, openGuest, openHost, snapshot, throttle, until, videoTime } from './helpers';

/**
 * PLAN.md 4.3's tiering, against the real-world file shapes from Phase 0.
 * Every message must name the actual cause: "a user whose file is rejected does
 * not conclude the file is unusual, they conclude the product is broken".
 */
test('moov-at-end plays, which is the most common real-world shape', async ({ page, context }) => {
	const { code } = await openHost(page, 'moov-at-end.mp4');
	const { page: guest } = await openGuest(context, code);

	const s = await until(
		() => snapshot(guest),
		(x) => x.ttff !== null,
		{
			what: 'the guest to play a file whose moov is after its mdat',
			timeout: 60_000
		}
	);
	expect(s.ttff).toBeLessThan(5000);
	expect((await snapshot(page)).tier).toBe('direct');
});

test('a file with no audio track plays', async ({ page, context }) => {
	const { code } = await openHost(page, 'no-audio.mp4');
	const { page: guest } = await openGuest(context, code);
	await until(
		() => snapshot(guest),
		(x) => x.ttff !== null,
		{
			what: 'video-only playback',
			timeout: 60_000
		}
	);
});

/**
 * PLAN.md 4.4 assumed AC-3 could always be transcoded to AAC via AudioDecoder.
 * Measured here: Chromium reports AudioDecoder.isConfigSupported({codec:'ac-3'})
 * === false, so it cannot decode it and therefore cannot convert it either.
 * 4.8 ("feature-detect, never UA-sniff") is the tiebreaker, so this file is an
 * honest reject. What matters is that the user is told the real reason instead
 * of getting silent video, which is the exact failure 4.4 was written to stop.
 */
test('AC-3 audio is rejected with the real reason, not silently muted', async ({ page }) => {
	await openHost(page, 'ac3-audio.mp4');

	const probed = await until(
		() => snapshot(page),
		(s) => s.tier !== null,
		{
			what: 'the probe to classify the file',
			timeout: 60_000
		}
	);
	// It must never claim to be playable and then play silently.
	expect(probed.tier).toBe('reject');

	await expect(page.getByTestId('unplayable')).toBeVisible();
	const shown = (await page.getByTestId('unplayable').textContent())!.toLowerCase();
	expect(shown, 'the message must name AC-3 rather than say "unsupported"').toContain('ac-3');
});

/**
 * A rejection message that says "remux it to MP4 first" is worthless if there is
 * nowhere left to put the remux. The picker used to unmount the moment a file
 * was rejected, so the only way to try another one was to reload -- which, for
 * a host, ends the room (PLAN.md Phase 1).
 */
test('a host can pick another file after one is rejected', async ({ page }) => {
	const { errors } = await openHost(page, 'ac3-audio.mp4');

	await expect(page.getByTestId('unplayable')).toBeVisible();
	await expect(page.getByTestId('file-picker')).toBeVisible();

	await page.getByTestId('file-input').setInputFiles(fixture('tiny-60s.mp4'));

	await until(
		() => snapshot(page),
		(s) => s.tier === 'direct',
		{ what: 'the second file to probe as directly playable', timeout: 60_000 }
	);
	// The second file supersedes the first: the room plays, and the message about
	// the rejected one is gone rather than sitting over a working player.
	await expect(page.getByTestId('video')).toBeVisible();
	await expect(page.getByTestId('unplayable')).toBeHidden();
	expect(errors, 'host page errors').toEqual([]);
});

/**
 * PLAN.md 4.5 + Phase 4: "a guest throttled to 1.5 Mbps continues playing at
 * 480p with zero stalls."
 *
 * Throttling is done on our own send path because CDP cannot shape WebRTC
 * (section 8 is wrong about that; measured 233 Mbps through a 1.5 Mbps "cap").
 *
 * The second half of the plan's criterion -- "lift the throttle and it returns
 * to native within ~15s" -- is in abr-recovery.spec.ts, because it cannot be
 * observed against a 60s fixture at all: once unthrottled, Shaka buffers the
 * whole remaining file in seconds, then never fetches again, so the estimator
 * has nothing to re-evaluate and the rung it is on is the rung it dies on. That
 * needs the long fixture the plan already specifies.
 */
test('a throttled guest drops down the ladder and keeps playing', async ({ page, context }) => {
	const { code } = await openHost(page, 'tiny-60s.mp4');
	const { page: guest } = await openGuest(context, code);
	await until(
		() => snapshot(guest),
		(s) => s.ttff !== null,
		{
			what: 'first frame',
			timeout: 60_000
		}
	);

	// The whole point of the rebuild: quality is a per-segment choice.
	const rungs = await snapshot(page);
	expect(rungs.availableRungs.length, 'the ladder must offer more than one rung').toBeGreaterThan(
		1
	);

	// The barrier would pause the room the moment we starve the guest, which
	// would mask whether ABR reacted. This test is about the ladder, so take the
	// barrier out of it (it is user-toggleable by design).
	await page.getByLabel('Pause when someone falls behind').uncheck();

	await throttle(page, 1_500_000);
	await page.getByTestId('play').click();

	const downshifted = await until(
		() => snapshot(guest),
		(s) => s.rung !== null && s.rung > 0,
		{
			what: 'ABR to downshift under a 1.5 Mbps cap',
			timeout: 90_000
		}
	);
	expect(downshifted.rung, 'a throttled guest must leave the native rung').toBeGreaterThan(0);
	// The rung it moved to must be one the host actually encoded, which is the
	// whole Phase 4 pipeline: demux -> decode -> encode -> mux -> serve.
	expect(downshifted.availableRungs).toContain(downshifted.rung);

	// "with zero stalls": the guest keeps advancing on the lower rung rather
	// than buffering. This is what the 360p floor in 4.5 exists to guarantee.
	const was = await videoTime(guest);
	await until(
		() => videoTime(guest),
		(t) => t > was + 1.5,
		{
			what: 'a throttled guest to keep playing rather than stall',
			timeout: 30_000
		}
	);
	expect((await snapshot(guest)).bufferedAhead).toBeGreaterThan(0);
});
