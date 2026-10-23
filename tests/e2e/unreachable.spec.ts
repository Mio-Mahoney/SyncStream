import { expect, test } from '@playwright/test';
import { guestPath, openRoom, snapshot } from './helpers';

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
	const { code, secret } = await openRoom(page);

	const guest = await context.newPage();
	await guest.addInitScript(() => {
		const Real = window.RTCPeerConnection;
		window.RTCPeerConnection = class extends Real {
			constructor(config?: RTCConfiguration) {
				super({ ...config, iceTransportPolicy: 'relay' });
			}
		};
	});
	await guest.goto(guestPath({ code, secret }));

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

	// What the verdict rests on is said. With no TURN server a relay-only
	// connection gathers nothing and Chromium leaves ICE sitting rather than
	// failing it, so this is the deadline case: the copy hedges towards a host
	// who may have left, rather than sending someone to switch networks.
	const cause = await waiting.locator('[data-cause]').getAttribute('data-cause');
	expect(['ice-failed', 'timeout']).toContain(cause);
	if (cause === 'timeout') await expect(waiting).toContainText('never finished opening');
	else await expect(waiting).toContainText("wouldn't let a direct connection through");

	// PLAN.md 9's measurement, from the side with no candidate to read: only
	// an observed ICE failure is counted as "needed TURN". A deadline that ran
	// out is not, because it cannot tell a strict NAT from a host who closed
	// the page - which was the review's F-13.
	expect((await snapshot(guest)).iceState).toBe(cause === 'ice-failed' ? 'failed' : 'new');
});
