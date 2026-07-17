import { expect, test } from '@playwright/test';
import { openGuest, openRoom } from './helpers';

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
