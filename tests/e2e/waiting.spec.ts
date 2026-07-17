import { expect, test } from '@playwright/test';
import { nameYourself, openGuest, openHost, openRoom, snapshot, until, videoTime } from './helpers';

/**
 * The guest's screen before there is a video on it.
 *
 * A guest has no picker and no controls, so until the host sends a stream this
 * screen IS the app for them. All three waits below used to render as one line
 * of grey text, and two of them were dead ends.
 */

test('a guest whose room has no host is told so, and given a way out', async ({ page }) => {
	// Nobody is hosting this. Rendezvous walks its whole ladder before saying
	// so, which is where the 20s-per-strategy budget goes.
	await page.goto('/room/K7M4PQ');

	const waiting = page.getByTestId('waiting-room');
	await expect(waiting).toHaveAttribute('data-phase', 'searching');

	await expect(waiting).toHaveAttribute('data-phase', 'failed', { timeout: 60_000 });
	await expect(page.getByTestId('waiting-title')).toContainText('No one is hosting');

	// The whole of the old failure state was the raw relay diagnostic, with no
	// control on the page: editing the URL was the only way on.
	await expect(page.getByTestId('retry')).toBeVisible();
	await page.getByTestId('go-home').click();
	await expect(page).toHaveURL(/\/$/);
});

test('a link with a broken code says so, rather than searching for it', async ({ page }) => {
	// A link cut short by a chat client. The whole of this state used to be the
	// banner 'That is not a valid room code.' under a header announcing 'Room
	// badcode-nonsense' in the same type as a real code, with nothing to click.
	await page.goto('/room/badcode-nonsense');

	const waiting = page.getByTestId('waiting-room');
	await expect(waiting).toHaveAttribute('data-phase', 'invalid');
	await expect(page.getByTestId('waiting-title')).toHaveText("That link isn't a room");

	// Not dressed up as a room it is not.
	await expect(page.getByTestId('room-code')).toHaveCount(0);
	// Nothing was attempted, so there is nothing to retry: the same broken code
	// cannot start working.
	await expect(page.getByTestId('retry')).toHaveCount(0);

	await page.getByTestId('go-home').click();
	await expect(page).toHaveURL(/\/$/);
});

test('a broken code is a dead end for a would-be host too', async ({ page }) => {
	// `?create=1` is the host's own URL. A code that cannot name a room leaves
	// nothing to host either, so this must not fall through to the picker.
	await page.goto('/room/badcode-nonsense?create=1');

	await expect(page.getByTestId('waiting-room')).toHaveAttribute('data-phase', 'invalid');
	await expect(page.getByTestId('file-picker')).toHaveCount(0);
	await expect(page.getByTestId('go-home')).toBeVisible();
});

test('the relay diagnostic survives, behind a disclosure', async ({ page }) => {
	await page.goto('/room/K7M4PQ');
	await expect(page.getByTestId('waiting-room')).toHaveAttribute('data-phase', 'failed', {
		timeout: 60_000
	});

	// Worth keeping for a bug report; worth hiding from someone who wants to
	// watch a film. It must be the per-strategy detail, not a restatement.
	await expect(page.getByText('Connection details')).toBeVisible();
	await page.getByText('Connection details').click();
	await expect(page.getByTestId('waiting-room')).toContainText(/no host answered within \d+ms/);
});

test('a host whose room will not open is told so, and given a way out', async ({ page }) => {
	// Every relay dead. The host's rendezvous walks its whole ladder and throws
	// the same RendezvousError a guest's failed join does -- which the page used
	// to route, for a host only, straight into the raw error banner.
	await page.routeWebSocket(/.*/, (ws) => ws.close());
	await page.goto('/?debug=1');
	await page.getByText('Create room').click();

	const waiting = page.getByTestId('waiting-room');
	await expect(waiting).toHaveAttribute('data-phase', 'unopened', { timeout: 60_000 });
	await expect(page.getByTestId('waiting-title')).toHaveText("Couldn't open the room");

	// The whole of this state was the relay log in a red banner, with no control
	// on the page: the only way on was editing the URL.
	await expect(page.getByTestId('error')).toHaveCount(0);
	await expect(page.getByTestId('retry')).toBeVisible();

	// The code was drawn by us and announced nowhere, so the header rendering it
	// at 2xl mono invited the host to send their friends a room that is not there.
	await expect(page.getByTestId('room-code')).toHaveCount(0);
	await expect(page).toHaveTitle(/Couldn't open the room/);

	// Kept for a bug report, out of the way of someone who wants to watch a film.
	await page.getByText('Connection details').click();
	await expect(waiting).toContainText(/did not connect within \d+ms/);

	await page.getByTestId('go-home').click();
	await expect(page).toHaveURL(/\/$/);
});

test('a host waiting for their room to open is told so, and shown no code yet', async ({
	page
}) => {
	// The invariant, watched rather than sampled: a code on screen is an
	// invitation to pass on, and until the announce lands there is nothing behind
	// it to join. Polled from before the page's own scripts run, so this covers
	// every frame of the wait rather than whichever ones a check happens to land
	// on -- the old bug showed the code from the very first render.
	await page.addInitScript(() => {
		(window as unknown as { __codeBeforeRoom: string[] }).__codeBeforeRoom = [];
		setInterval(() => {
			const code = document.querySelector('[data-testid=room-code]')?.textContent?.trim();
			const open = document.querySelector('[data-testid=file-input]');
			if (code && !open)
				(window as unknown as { __codeBeforeRoom: string[] }).__codeBeforeRoom.push(code);
		}, 20);
	});
	await page.goto('/');
	await page.getByText('Create room').click();

	// A relay round trip plus the occupancy probe: seconds, not a frame. The
	// whole of it used to be 'Opening the room...' in grey, with no spinner --
	// the one thing telling 'working on it' apart from 'hung'.
	const waiting = page.getByTestId('waiting-room');
	await expect(waiting).toHaveAttribute('data-phase', 'opening');
	await expect(waiting.getByRole('status')).toBeVisible();
	await expect(page).toHaveTitle(/Opening your room/);

	// Then the room is real, and so is the code.
	await expect(page.getByTestId('file-input')).toBeAttached({ timeout: 45_000 });
	await expect(page.getByTestId('room-code')).toBeVisible();
	await expect(waiting).toHaveCount(0);

	// We draw the code ourselves and only learn whether it is free by announcing
	// it and seeing whether a rival host answers, so before that it is a guess --
	// and on a collision it is a stranger's live room, swapped out silently once
	// the probe clears.
	expect(
		await page.evaluate(() => (window as { __codeBeforeRoom?: string[] }).__codeBeforeRoom)
	).toEqual([]);
});

test('a guest who arrives before the host picks a file knows it is connected', async ({
	page,
	context
}) => {
	// Stops at the picker: the room is announced and the host is reachable, but
	// there is no video yet.
	const { code } = await openRoom(page);
	const { page: guest } = await openGuest(context, code);

	// Regression: this said 'Looking for the host...' -- while sitting connected
	// to it -- for as long as the host took to choose, telling a guest who had
	// done everything right that their code was probably wrong.
	const waiting = guest.getByTestId('waiting-room');
	await expect(waiting).toHaveAttribute('data-phase', 'found', { timeout: 45_000 });
	await expect(waiting).toContainText('Connected to Host');
	await expect(guest.getByTestId('waiting-title')).toHaveText("You're in");
});

test('a guest whose host leaves has the film stopped, not just hidden', async ({
	page,
	context
}) => {
	const { code } = await openHost(page, 'tiny-60s.mp4');
	const { page: guest } = await openGuest(context, code);

	await until(
		() => snapshot(guest),
		(s) => s.ttff !== null,
		{
			what: 'the guest to render a first frame',
			timeout: 60_000
		}
	);
	await page.getByTestId('play').click();
	await until(
		() => videoTime(guest),
		(t) => t > 1,
		{ what: 'the guest to advance' }
	);

	// The host walks out mid-film, with the guest's ~12s lookahead buffer full.
	await page.close();

	const waiting = guest.getByTestId('waiting-room');
	await expect(waiting).toHaveAttribute('data-phase', 'ended', { timeout: 30_000 });
	await expect(guest.getByTestId('waiting-title')).toHaveText('The watch party is over');

	// Regression: `ready` only ever took the player off screen, and display:none
	// does not stop a <video>. Worse, GuestSync re-asserts the host's last state
	// every tick, so with no host left to update it the loop re-asserted `playing`
	// forever -- the film played on, audible and invisible, behind a page that
	// said the party was over and that there was nothing left to play.
	const stopped = await guest.evaluate(() => {
		const v = document.querySelector('video') as HTMLVideoElement;
		return { paused: v.paused, at: v.currentTime };
	});
	expect(stopped.paused, 'the film stops when the room does').toBe(true);

	// Pinned separately from `paused` because the sync loop is what undid the
	// pause before: a single check would pass against a film that restarts a
	// tick later. This is the assertion the fix is actually about.
	await new Promise((r) => setTimeout(r, 3000));
	const later = await guest.evaluate(() => {
		const v = document.querySelector('video') as HTMLVideoElement;
		return { paused: v.paused, at: v.currentTime };
	});
	expect(later.paused, 'and stays stopped -- nothing restarts it').toBe(true);
	expect(later.at, 'and does not advance').toBeCloseTo(stopped.at, 2);
});

test('a guest watching fullscreen is let out of it when the room ends', async ({
	page,
	context
}) => {
	const { code } = await openHost(page, 'tiny-60s.mp4');
	const { page: guest } = await openGuest(context, code);

	await until(
		() => snapshot(guest),
		(s) => s.ttff !== null,
		{ what: 'the guest to render a first frame', timeout: 60_000 }
	);
	await page.getByTestId('play').click();
	await until(
		() => videoTime(guest),
		(t) => t > 1,
		{ what: 'the guest to advance' }
	);

	// The way a film is actually watched.
	await guest.getByTestId('fullscreen').click();
	await expect
		.poll(() => guest.evaluate(() => !!document.fullscreenElement), {
			message: 'the guest to be watching fullscreen'
		})
		.toBe(true);

	// The host walks out.
	await page.close();

	const waiting = guest.getByTestId('waiting-room');
	await expect(waiting).toHaveAttribute('data-phase', 'ended', { timeout: 60_000 });

	// Regression: the room ending only ever hid the player, and display:none does
	// not exit fullscreen -- the browser stayed in fullscreen mode with the
	// fullscreen element rendering nothing, so the guest was left in a chromeless
	// window with no control on screen accounting for why it would not come back.
	await expect
		.poll(() => guest.evaluate(() => document.fullscreenElement?.tagName ?? null), {
			message: 'the room ending to let the guest out of fullscreen'
		})
		.toBe(null);

	// The way out has to be on screen, not merely in the DOM: the whole point of
	// leaving fullscreen is that the page underneath is where the only remaining
	// control lives.
	await expect(guest.getByTestId('waiting-title')).toBeVisible();
	await expect(guest.getByRole('link', { name: 'Back to start' })).toBeVisible();
});

test('a guest waiting for the host is told who else is waiting', async ({ page, context }) => {
	const { code } = await openRoom(page);

	// Deliberately named, and deliberately not left as "Guest 284": the claim is
	// that a guest reads the OTHER guest, and two machine-generated names that
	// differ only in three digits make a passing assertion hard to trust.
	const alice = await openGuest(context, code);
	await nameYourself(alice.page, 'guest-name', 'Alice');

	// Alone with the host so far. Silence rather than "no one else is here": that
	// is news a host needs (their link may not have worked) and nothing a guest
	// who arrived first can act on.
	await expect(
		alice.page.getByTestId('waiting-others'),
		'a guest waiting alone is not told the room is empty'
	).toHaveCount(0);

	const bob = await openGuest(context, code);
	await nameYourself(bob.page, 'guest-name', 'Bob');

	// Regression, and the whole claim: the host has read this same roster by name
	// since the invite panel, while a guest sitting beside those very people had a
	// screen naming only the host. Asserted against the whole card so an unfixed
	// build fails printing what a guest actually read.
	const waitingRoom = (p: typeof alice.page) => p.getByTestId('waiting-room');
	await expect(
		waitingRoom(alice.page),
		'a guest must be told who else is waiting with them'
	).toContainText('Bob is waiting too.', { timeout: 45_000 });
	await expect(waitingRoom(bob.page)).toContainText('Alice is waiting too.', { timeout: 45_000 });

	// The two ways the line could go wrong, and both are silent. A guest is never
	// told which name is its own, so its own name here reads as one more stranger;
	// and the host is named on the line above, so naming them again reads as two
	// people in a two-person room.
	await expect(alice.page.getByTestId('waiting-others')).not.toContainText('Alice');
	await expect(bob.page.getByTestId('waiting-others')).not.toContainText('Bob');
	for (const g of [alice, bob]) {
		await expect(g.page.getByTestId('waiting-others')).not.toContainText('Host');
		// Still the wait it always was -- the roster is a fact added to this screen,
		// not a replacement for the one thing that proves the code was right.
		await expect(g.page.getByTestId('waiting-room')).toContainText('Connected to Host.');
	}

	expect(alice.errors.concat(bob.errors), 'guest page errors').toEqual([]);
});
