import { expect, test } from '@playwright/test';
import { fixture, openGuest, openRoom, snapshot, throttle, until, videoTime } from './helpers';

/**
 * Pressing play while the room is being held for someone is a decision to
 * stop waiting for them, and the film has always obeyed it. The banner did
 * not: the barrier only speaks when the list of who is behind changes, nobody
 * had caught up, and so "Waiting for Guest 412 to catch up" stayed on every
 * screen over a film that was running.
 *
 * The second half is what the fix must not turn into: a barrier that re-arms
 * on the guest's next status report and pauses the film a second after
 * somebody deliberately started it.
 */
test('playing through the barrier takes its banner down, and it stays down', async ({
	page,
	context
}) => {
	const { code } = await openRoom(page);
	const { page: guest } = await openGuest(context, code);
	await until(
		() => snapshot(page),
		(s) => s.peers.length === 1,
		{ what: 'the guest to reach the host', timeout: 60_000 }
	);

	// Throttled before the file, so the guest is behind from its first report.
	await throttle(page, 400_000);
	await page.getByTestId('file-input').setInputFiles(fixture('tiny-60s.mp4'));
	await until(
		() => snapshot(page),
		(s) => s.waitingOn.length > 0,
		{ what: 'the barrier to hold the room for the guest', timeout: 60_000 }
	);
	await expect(guest.getByTestId('waiting')).toBeVisible({ timeout: 30_000 });

	await page.getByTestId('play').click();

	await until(
		() => snapshot(page),
		(s) => s.playing && s.waitingOn.length === 0,
		{ what: 'the host banner to come down once the film is running', timeout: 5_000 }
	);
	await expect(guest.getByTestId('waiting')).toBeHidden();

	// Several status ticks later the film is still running and nobody is being
	// waited for, whether or not the guest has caught up.
	await until(
		() => videoTime(page),
		(t) => t > 3,
		{ what: 'the film to keep playing', timeout: 15_000 }
	);
	const after = await snapshot(page);
	expect(after.playing, 'the barrier must not pause a film someone chose to play').toBe(true);
	expect(after.waitingOn).toEqual([]);
});
