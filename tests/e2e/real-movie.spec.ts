import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { fixture, openGuest, openHost, snapshot, until, videoTime } from './helpers';

/**
 * A real movie, when one is present. The committed fixtures are synthetic
 * shapes generated to provoke one code path each; this spec is the opposite
 * claim: a genuine full-length film -- whatever container quirks, codec
 * profile, and keyframe cadence a real encoder produced -- goes through the
 * whole pipeline and plays. Real content is what the probe's thresholds and
 * tier messages are calibrated against, and this is where that calibration
 * meets an actual film instead of a testsrc2 pattern.
 *
 * Gitignored by design (size, and it is other people's content): symlink any
 * real film to tests/fixtures/real-movie.mp4 to light this up. CI never has
 * one, so CI skips this -- like scale.spec.ts, it is a scale check for a
 * machine that has the goods.
 */
const movie = fixture('real-movie.mp4');

test.describe(() => {
	test.skip(
		!existsSync(movie),
		'needs tests/fixtures/real-movie.mp4 (symlink any real film there)'
	);
	test.setTimeout(300_000);

	test('a real movie is classified honestly and plays end to end', async ({ page, context }) => {
		const { code } = await openHost(page, 'real-movie.mp4');

		// Whatever tier the probe picks, it must pick one and it must not be
		// reject: a mainstream film off a shelf is the product's whole reason to
		// exist, and a reject here means a threshold or a codec verdict is
		// calibrated against fixtures instead of films.
		const probed = await until(
			() => snapshot(page),
			(s) => s.tier !== null,
			{ what: 'the probe to classify a real film', timeout: 60_000 }
		);
		expect(probed.tier, 'a real mainstream film must never be rejected').not.toBe('reject');

		const { page: guest } = await openGuest(context, code);
		await until(
			() => snapshot(guest),
			(s) => s.ttff !== null,
			{
				// Generous by design: a transcode-tier film pays for its first
				// encode here, and this spec's claim is "it works", not a latency
				// bar the synthetic fixtures already hold elsewhere.
				what: 'first frame of a real film',
				timeout: 120_000
			}
		);

		// From the top. A film's edit list can start a couple of frames after its
		// first keyframe (an x265 rip does), and a stream that begins on the edit
		// throws that keyframe away and its whole GOP with it: this film's first
		// ten seconds, missing from every guest, while the host watched them.
		const start = await guest.evaluate(() => {
			const v = document.querySelector('video') as HTMLVideoElement;
			return v.buffered.length > 0 ? v.buffered.start(0) : -1;
		});
		expect(start, "the guest's film must be buffered from its first frame").toBeGreaterThanOrEqual(
			0
		);
		expect(start).toBeLessThan(0.5);

		await page.getByTestId('play').click();
		const was = await videoTime(guest);
		await until(
			() => videoTime(guest),
			(t) => t > was + 5,
			{ what: 'a real film to actually play', timeout: 60_000 }
		);
		expect((await snapshot(guest)).bufferedAhead).toBeGreaterThan(0);
	});
});
