import { expect, test } from '@playwright/test';
import { openGuest, openHost, snapshot, until, videoTime } from './helpers';

/**
 * PLAN.md 4.3's tier 2, from the seat nobody had tested it from: the host's.
 *
 * A file the browser cannot play but can decode is converted as it streams,
 * and guests have always been sent the result. The host was sent nothing. Its
 * <video> was only ever given a source when the file played straight off disk,
 * so for a converted film it sat empty - and the host's element is the room's
 * clock. It reported "paused at 0" forever, every play was a play() on an
 * element with no source, and the guests got a first frame and then a film
 * that never started.
 *
 * No committed fixture is tier 2 on this machine (hevc.mp4 decodes natively
 * here), so the host is told its MSE cannot take HEVC. That is exactly the
 * browser the tier exists for: WebCodecs can still decode the file, so the
 * probe picks `transcode`, and everything downstream is the real pipeline.
 */
test('the host can watch a film it has to convert', async ({ page, context }) => {
	await page.addInitScript(() => {
		const real = MediaSource.isTypeSupported.bind(MediaSource);
		MediaSource.isTypeSupported = (type: string) => !/hvc1|hev1/.test(type) && real(type);
	});

	const { code, secret, errors } = await openHost(page, 'hevc.mp4');
	await until(
		() => snapshot(page),
		(s) => s.tier === 'transcode',
		{ what: 'the probe to pick tier 2', timeout: 45_000 }
	);

	const { page: guest } = await openGuest(context, { code, secret });
	await until(
		() => snapshot(guest),
		(s) => s.ttff !== null,
		{ what: 'the guest to render a first frame', timeout: 60_000 }
	);

	await page.getByTestId('play').click();

	// The host's own picture, which is also what makes the room's clock run.
	await until(
		() => videoTime(page),
		(t) => t > 1,
		{ what: 'the host playhead to advance', timeout: 60_000 }
	);
	await until(
		() => videoTime(guest),
		(t) => t > 1,
		{ what: 'the guest playhead to advance', timeout: 30_000 }
	);
	const synced = await until(
		() => snapshot(guest),
		(s) => s.playing && Math.abs(s.drift) < 0.5,
		{ what: 'the guest to lock onto the host clock', timeout: 30_000 }
	);
	expect(Math.abs(synced.drift)).toBeLessThan(0.5);
	expect(errors, 'host page errors').toEqual([]);
});
