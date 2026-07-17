import { expect, test, type Page } from '@playwright/test';
import { nameYourself, openGuest, openHost, snapshot, until } from './helpers';

/**
 * Anyone in the room can stop the film for everyone: a guest's play button sends
 * intent and the host obeys it (PLAN.md 4.9). So the room has to be able to say
 * who did - and until it could, the only account anybody got was the play button
 * quietly flipping its glyph under a picture that had halted.
 */

/**
 * Turns the readiness barrier off for the rest of the run.
 *
 * Not incidental setup. The barrier answers the same question this notice does
 * ("why has the film stopped") and deliberately outranks it on screen, so a
 * barrier that trips on the opening buffer would hide the very sentence these
 * tests are about - measured, once, in a run of this exact scenario. The
 * attribution has nothing to do with anyone's buffer, so removing the barrier
 * removes a race rather than weakening a claim.
 */
async function stopWatchingBuffers(host: Page) {
	await host.getByLabel('Pause when someone falls behind').uncheck();
	await until(
		() => snapshot(host),
		(s) => s.waitingOn.length === 0,
		{
			what: 'the barrier to let go of the room'
		}
	);
}

/** Everyone is named, the film is on, and it has genuinely started for the guest. */
async function watchingTogether(page: Page, ctx: Parameters<typeof openGuest>[0]) {
	const { code } = await openHost(page, 'tiny-60s.mp4');
	await nameYourself(page, 'host-name', 'Alice');
	const { page: g } = await openGuest(ctx, code);
	await expect(g.getByTestId('video')).toBeVisible({ timeout: 45_000 });
	await nameYourself(g, 'guest-name', 'Bob');
	await stopWatchingBuffers(page);

	await page.getByTestId('play').click();
	await until(
		() => snapshot(g),
		(s) => s.playing && s.mediaTime > 0.3,
		{
			what: 'the film to be running for the guest'
		}
	);
	return { code, guest: g };
}

test('a guest who pauses the film is named to everyone but themselves', async ({
	page,
	context
}) => {
	const { guest } = await watchingTogether(page, context);

	await guest.getByTestId('play').click();
	await until(
		() => snapshot(page),
		(s) => !s.playing,
		{ what: 'the host to stop' }
	);

	// The fix. Without it the host's screen carries on saying "Now playing" and
	// "Bob is here" over a picture that stopped for reasons it never mentions.
	await expect(page.getByTestId('paused-by'), 'the room must say who stopped the film').toHaveText(
		'Bob paused the film.'
	);

	// Bob knows. He pressed it a second ago, and `you` comes from the host rather
	// than from Bob matching a name he could be sharing with another guest.
	await expect(guest.getByTestId('paused-by')).toHaveCount(0);
});

test('the host pausing is named to the guests, and clears when the film runs again', async ({
	page,
	context
}) => {
	const { guest } = await watchingTogether(page, context);

	await page.getByTestId('play').click();
	await until(
		() => snapshot(guest),
		(s) => !s.playing,
		{ what: 'the guest to stop' }
	);
	await expect(guest.getByTestId('paused-by')).toHaveText('Alice paused the film.');
	await expect(page.getByTestId('paused-by')).toHaveCount(0);

	// The other half, and the one that would rot silently: an attribution that
	// outlived the pause would sit over a running film explaining nothing.
	await page.getByTestId('play').click();
	await until(
		() => snapshot(guest),
		(s) => s.playing,
		{ what: 'the guest to run again' }
	);
	await expect(guest.getByTestId('paused-by')).toHaveCount(0);
});

test('a guest arriving at a stopped film is told why it is stopped', async ({ page, context }) => {
	const { code } = await watchingTogether(page, context);

	await page.getByTestId('play').click();
	await until(
		() => snapshot(page),
		(s) => !s.playing,
		{ what: 'the host to stop' }
	);

	// Nobody watched this one stop, which is exactly why they need telling: a film
	// that is simply motionless on arrival is indistinguishable from a broken one.
	const { page: late } = await openGuest(context, code);
	await expect(late.getByTestId('video')).toBeVisible({ timeout: 45_000 });
	await expect(late.getByTestId('paused-by')).toHaveText('Alice paused the film.');
});
