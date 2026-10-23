import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
	expectFilmEnd,
	fixture,
	openGuest,
	openHost,
	snapshot,
	until,
	videoEndState
} from './helpers';

/**
 * The last second is fully buffered but cannot satisfy a five-second readiness
 * threshold. Watch every full-watch sample so a later resume cannot conceal a
 * pause nobody asked for. A seek can legitimately hold while its destination
 * loads, but must clear that hold even when fewer than five seconds remain.
 *
 * The host's natural-end pause can reach a guest just before its slightly
 * longer MSE duration. That separate sync issue is outside the barrier's scope:
 * require host ended and guest ended or paused within 250ms of its own duration.
 */
for (const { file, start } of [
	{ file: 'tiny-60s.mp4', start: 0 },
	{ file: 'edit-list.mp4', start: 0 },
	{ file: 'tiny-60s.mp4', start: 56 },
	{ file: 'tiny-60s.mp4', start: 59 }
]) {
	test(
		start === 0 ? `a full watch of ${file} reaches ended` : `a seek to ${start}s reaches ended`,
		async ({ page, context }, testInfo) => {
			const { code, secret } = await openHost(page, file);
			await expect(page.getByLabel('Pause when someone falls behind')).toBeChecked();
			const { page: guest } = await openGuest(context, { code, secret });
			await until(
				() => snapshot(page),
				(s) => s.peers.length === 1 && s.peers[0].bufferedAhead > 5 && s.waitingOn.length === 0,
				{ what: 'the guest to be ready before playing with the default barrier', timeout: 60_000 }
			);

			if (start > 0) {
				await page.getByTestId('seek').fill(String(start));
				await page.getByTestId('seek').dispatchEvent('change');
				/** Start together so host EOF does not pause a guest still loading the seek. */
				await until(
					() => snapshot(page),
					(s) => s.peers[0]?.atEnd && s.waitingOn.length === 0,
					{ what: 'the guest to buffer the ending and release any seek hold', timeout: 30_000 }
				);
			}
			await page.getByTestId('play').click();

			await expectFilmEnd(page, guest, testInfo, start === 0);
		}
	);
}

const movie = fixture('real-movie.mp4');

test('a real film reaches its ending without a readiness hold', async ({
	page,
	context
}, testInfo) => {
	test.skip(
		!existsSync(movie),
		'needs tests/fixtures/real-movie.mp4 (symlink any real film there)'
	);
	test.setTimeout(300_000);
	const { code, secret } = await openHost(page, 'real-movie.mp4');
	await expect(page.getByLabel('Pause when someone falls behind')).toBeChecked();
	const { page: guest } = await openGuest(context, { code, secret });
	await until(
		() => snapshot(page),
		(s) => s.peers.length === 1 && s.peers[0].bufferedAhead > 5 && s.waitingOn.length === 0,
		{ what: 'the real-film guest to be ready before seeking', timeout: 120_000 }
	);
	const { duration } = await videoEndState(page);
	await page.getByTestId('seek').fill((duration - 8).toFixed(1));
	await page.getByTestId('seek').dispatchEvent('change');
	await until(
		() => snapshot(page),
		(s) => s.peers[0]?.atEnd && s.waitingOn.length === 0,
		{ what: 'the real-film ending to buffer before playing', timeout: 120_000 }
	);
	await page.getByTestId('play').click();
	await expectFilmEnd(page, guest, testInfo, true);
});
