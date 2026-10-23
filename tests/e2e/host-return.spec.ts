import { expect, test } from '@playwright/test';
import { fixture, openGuest, openHost, snapshot, until, videoTime } from './helpers';

/**
 * A host who reloads the page comes back as a new page on the same code, and
 * every guest who stayed is still in the room to meet it.
 *
 * Two things stood between them. The guest's screen had already said "the
 * watch party is over" and nothing could take that back, so the room the host
 * reopened was one its guests could not see. And underneath, the sync engine
 * was still holding the old page's last state: `seq` starts again at 1 on a
 * new page, so every state the new host sent lost to the last one the old host
 * did, for as many seconds as the old host had been running.
 *
 * The old host plays for a while first for that reason - the longer it ran,
 * the longer its guests would go on ignoring its successor.
 */
test('a host who reloads gets their guests back, following the new page at once', async ({
	page,
	context
}) => {
	const { code, secret } = await openHost(page, 'tiny-60s.mp4');
	const { page: guest } = await openGuest(context, { code, secret });
	await until(
		() => snapshot(guest),
		(s) => s.ttff !== null,
		{ what: 'first frame', timeout: 60_000 }
	);

	await page.getByTestId('play').click();
	await until(
		() => videoTime(page),
		(t) => t > 12,
		{ what: 'the first host to have been playing a while', timeout: 30_000 }
	);

	await page.reload();
	await expect(page.getByTestId('file-input')).toBeAttached({ timeout: 45_000 });
	expect((await page.getByTestId('room-code').textContent())!.trim(), 'the same room').toBe(code);

	// Not "the watch party is over": the host is back, and says so.
	await expect(guest.getByTestId('waiting-room')).toHaveAttribute('data-phase', 'found', {
		timeout: 30_000
	});

	await page.getByTestId('file-input').setInputFiles(fixture('tiny-60s.mp4'));
	await expect(guest.getByTestId('waiting-room')).toHaveCount(0, { timeout: 30_000 });
	await until(
		() => guest.evaluate(() => document.querySelector('video')!.readyState),
		(r) => r >= 2,
		{ what: 'the guest to load the film from the new host', timeout: 30_000 }
	);

	await page.getByTestId('play').click();
	await until(
		() => videoTime(page),
		(t) => t > 0.5,
		{ what: 'the new host to be playing' }
	);

	// Well inside the ~12s the old page's seq would have outranked the new one.
	const following = await until(
		() => snapshot(guest),
		(s) => s.playing && s.mediaTime > 0.5,
		{ what: "the guest to follow the new host's play", timeout: 5_000 }
	);
	expect(
		following.mediaTime,
		'the guest must be in the new film, not parked in the old'
	).toBeLessThan(10);
});
