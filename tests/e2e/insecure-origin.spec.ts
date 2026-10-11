import { expect, test } from '@playwright/test';
import { appPath } from './base';

/**
 * The obvious way to try the app across two of your own computers is to serve
 * it from one and open that computer's LAN address on the other. That page
 * loads and looks ready, and cannot work: http://192.168.x.x is not a secure
 * context, so the browser withholds `crypto.subtle`, and the signaling layer
 * throws on every message it tries to hash or encrypt.
 *
 * None of that reached the screen. The guest searched for thirty seconds and
 * was told "No one is hosting room X. Check the code" - about a room whose
 * host was on the same network, with the right code.
 *
 * A loopback server only serves secure contexts under its own name, so the
 * browser here is given a second name for it. The origin is then plain http
 * on a host that is not localhost, which is exactly the LAN-address case.
 */
test.use({
	launchOptions: { args: ['--host-resolver-rules=MAP insecure.test localhost'] }
});

for (const role of ['guest', 'host'] as const) {
	test(`a ${role} on a plain-http address is told why nothing will connect`, async ({ page }) => {
		const query = role === 'host' ? '?create=1&s=local' : '?s=local';
		await page.goto(`http://insecure.test:4173${appPath(`/room/K7M4PQ${query}`)}`);
		expect(await page.evaluate(() => window.isSecureContext), 'the premise').toBe(false);

		const waiting = page.getByTestId('waiting-room');
		// At once, not after a rendezvous budget spent finding nothing.
		await expect(waiting).toHaveAttribute('data-phase', 'insecure', { timeout: 5_000 });
		await expect(page.getByTestId('waiting-title')).toHaveText("This address can't connect");
		await expect(waiting).toContainText('insecure.test:4173');
		await expect(waiting).toContainText('https');

		// Not dressed up as a room, and no way to host one from here.
		await expect(page.getByTestId('room-code')).toHaveCount(0);
		await expect(page.getByTestId('file-picker')).toHaveCount(0);
	});
}
