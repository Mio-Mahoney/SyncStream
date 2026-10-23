import { expect, test, type Page } from '@playwright/test';
import { openGuest, openHost, snapshot, until, videoTime } from './helpers';

/**
 * Only the host scrubs through the film. A guest may still pause and play it
 * (pause.spec.ts), but where the film is belongs to the host.
 *
 * Two halves, because the guest's page is not the rule. Its seek bar is
 * read-only, which is the page being honest; the host dropping a guest's seek
 * intent is the guarantee, since a guest is a peer the host does not control.
 */

/** See pause.spec.ts: the barrier would hold the film and hide what is measured. */
async function stopWatchingBuffers(host: Page) {
	await host.getByLabel('Pause when someone falls behind').uncheck();
	await until(
		() => snapshot(host),
		(s) => s.waitingOn.length === 0,
		{ what: 'the barrier to let go of the room' }
	);
}

test("a guest's seek bar shows the film but cannot move it", async ({ page, context }) => {
	const { code, secret } = await openHost(page, 'tiny-60s.mp4');
	const { page: guest } = await openGuest(context, { code, secret });
	await expect(guest.getByTestId('video')).toBeVisible({ timeout: 45_000 });
	await stopWatchingBuffers(page);

	await expect(page.getByTestId('seek'), 'the host scrubs').toBeEnabled();
	await expect(guest.getByTestId('seek'), 'a guest does not').toBeDisabled();
	await expect(guest.getByTestId('seek')).toHaveAttribute(
		'title',
		'Only the host can skip through the film'
	);

	// The arrow keys are the other way to skip. Pressed, then `k` to play: the
	// play lands on the host after anything the arrows sent on the same ordered
	// channel, so a film that starts from the top is one nothing moved.
	for (let i = 0; i < 4; i++) await guest.keyboard.press('ArrowRight');
	await guest.keyboard.press('k');
	await until(
		() => snapshot(page),
		(s) => s.playing,
		{ what: "the host to obey the guest's play" }
	);
	expect(await videoTime(page), "a guest's arrow keys must not move the film").toBeLessThan(5);
});

test("the host refuses a guest's seek that arrives anyway", async ({ page, context }) => {
	const { code, secret } = await openHost(page, 'tiny-60s.mp4');

	// The guest's first intent leaves the tab as a seek to 40s. Forged at the
	// transport, because the guest's own page no longer sends one: the gap being
	// tested is the host trusting the wire.
	const guest = await context.newPage();
	await guest.addInitScript(() => {
		const send = RTCDataChannel.prototype.send;
		let forged = false;
		RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: unknown) {
			if (!forged && typeof data === 'string' && data.includes('"t":"intent"')) {
				try {
					const m = JSON.parse(data);
					if (m?.t === 'intent') {
						forged = true;
						data = JSON.stringify({ t: 'intent', action: 'seek', mediaTime: 40 });
					}
				} catch {
					// Not ours to change: pass it on exactly as it was.
				}
			}
			return (send as (d: unknown) => void).call(this, data);
		};
	});
	await openGuest(context, { code, secret }, undefined, guest);
	await expect(guest.getByTestId('video')).toBeVisible({ timeout: 45_000 });
	await stopWatchingBuffers(page);

	// First press: the forged seek. Second: a real play, on the same ordered
	// channel, so by the time the host is playing it has handled the seek.
	await guest.getByTestId('play').click();
	await guest.getByTestId('play').click();
	await until(
		() => snapshot(page),
		(s) => s.playing,
		{ what: "the host to obey the guest's play" }
	);
	expect(await videoTime(page), "the host must not follow a guest's seek").toBeLessThan(5);
});
