import { expect, test } from '@playwright/test';
import { appPath } from './base';
import { openRoom, snapshot } from './helpers';

/**
 * NET-01: a connection that fails on NAT says so.
 *
 * With no TURN server (PLAN.md 9) a guest behind a NAT that STUN cannot
 * traverse finds the room over the relay and then cannot open a connection to
 * it. The rendezvous layer only ever counted a peer once it was connected, so
 * that guest looked exactly like one whose room was empty, and was told "No
 * one is hosting room X. Check the code" - about a room whose host had just
 * answered it.
 *
 * `iceTransportPolicy: 'relay'` with no TURN server configured is that guest,
 * exactly: signaling works, and no candidate pair can ever form.
 */
test('a guest who finds the room but cannot connect is told that, not that nobody is hosting', async ({
	page,
	context
}) => {
	const { code } = await openRoom(page);

	const guest = await context.newPage();
	await guest.addInitScript(() => {
		const Real = window.RTCPeerConnection;
		window.RTCPeerConnection = class extends Real {
			constructor(config?: RTCConfiguration) {
				super({ ...config, iceTransportPolicy: 'relay' });
			}
		};
	});
	await guest.goto(appPath(`/room/${code}?debug=1&s=local`));

	const waiting = guest.getByTestId('waiting-room');
	await expect(waiting).toHaveAttribute('data-phase', 'unreachable', { timeout: 60_000 });
	await expect(guest.getByTestId('waiting-title')).toContainText("Couldn't connect");
	await expect(guest.getByTestId('waiting-title')).toContainText(code);

	// A second negotiation is a real action here, unlike a broken code.
	await expect(guest.getByTestId('retry')).toBeVisible();
	await expect(guest.getByTestId('go-home')).toBeVisible();

	// The detail a bug report needs, behind the disclosure like the others.
	await waiting.getByText('Connection details').click();
	await expect(waiting).toContainText('found the room');

	// PLAN.md 9's measurement, counted from the side with no candidate to read.
	expect((await snapshot(guest)).iceState).toBe('failed');
});
