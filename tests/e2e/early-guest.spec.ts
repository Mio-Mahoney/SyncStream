import { expect, test } from '@playwright/test';
import { freshRoom, guestPath, hostPath, snapshot, until } from './helpers';

/**
 * A room spends its first second and a half checking that its code is free
 * (PLAN.md 4.7), listening on the very connections it will go on to use. A
 * guest who connects inside that window says hello to the check, not to the
 * room - and a hello is said once.
 *
 * The guest saw nothing wrong: it was told the host's name and waited for a
 * film. The host never learned it had company. No name on the invite panel,
 * no entry in the roster the other guests are sent, until somebody else
 * joining happened to restate it.
 *
 * Opening the guest first is what puts it inside the window every time: it is
 * already announcing when the host arrives, so the connection is up within
 * the host's first few hundred milliseconds.
 */
test('a guest already waiting when the room opens is met, not missed', async ({
	page,
	context
}) => {
	const room = freshRoom();

	const guest = await context.newPage();
	await guest.goto(guestPath(room));
	await expect(guest.getByTestId('waiting-room')).toHaveAttribute('data-phase', 'searching');

	await page.goto(hostPath(room));
	await expect(page.getByTestId('file-input')).toBeAttached({ timeout: 45_000 });

	await expect(guest.getByTestId('waiting-room')).toHaveAttribute('data-phase', 'found', {
		timeout: 30_000
	});

	// A peer the host has only a connection to is listed under its peer id. One
	// it has been introduced to is listed under the name it gave.
	const met = await until(
		() => snapshot(page),
		(s) => s.peers.some((p) => /^Guest \d+$/.test(p.name)),
		{ what: 'the host to learn its guest by name', timeout: 10_000 }
	);
	expect(met.peers).toHaveLength(1);
	await expect(page.getByTestId('invite-panel')).toContainText(/Guest \d+/);
});
