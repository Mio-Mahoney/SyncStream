import { expect, test } from '@playwright/test';
import { openGuest, openRoom } from './helpers';

/**
 * The host's side of the wait. A room with no one in it is not a watch party,
 * so getting the link out and learning that it worked is the whole job of the
 * screen the host lands on.
 */

test('the host can copy the invite link before picking a video', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	const { code, errors } = await openRoom(page);

	// On screen, not just on the clipboard: a link you can read is a link you can
	// check, select, and send by hand when the copy button is refused.
	await expect(page.getByTestId('invite-link')).toHaveValue(new RegExp(`/room/${code}`));

	await page.getByTestId('copy-link').click();
	await expect(page.getByTestId('copy-link')).toHaveText('Copied');
	expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`/room/${code}`);
	expect(errors, 'host page errors').toEqual([]);
});

test('a refused clipboard leaves the link selected rather than doing nothing', async ({ page }) => {
	// Browsers refuse `writeText` for reasons the page cannot control: an
	// unfocused document, a permissions policy, an origin that is not secure
	// (where `navigator.clipboard` is not even defined). The button used to
	// swallow that, leaving the host no way to invite anyone at all.
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: () => Promise.reject(new DOMException('Document is not focused.'))
			}
		});
	});
	await openRoom(page);

	await page.getByTestId('copy-link').click();

	await expect(page.getByTestId('copy-manual')).toBeVisible();
	await expect(page.getByTestId('copy-link')).toHaveText('Copy');
	// The fallback the message tells them to use has to actually be in place.
	const selected = await page.evaluate(() => {
		const el = document.activeElement as HTMLInputElement | null;
		return el?.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0) ?? '';
	});
	expect(selected).toContain('/room/');
});

test('a guest who joins before the video is picked shows up for the host', async ({
	page,
	context
}) => {
	const { code, errors } = await openRoom(page);
	await expect(page.getByTestId('invite-guests')).toHaveText(/No one has joined yet/);

	const { page: guest } = await openGuest(context, code);

	// The host knew this all along -- `guests` is populated on the first hello --
	// but the only thing rendering it lived inside the player block, hidden until
	// playback. A host waiting for friends could not tell whether the link had
	// worked, or whether to start without them.
	await expect(page.getByTestId('invite-guests')).toHaveText(/Guest \d+ is here/, {
		timeout: 45_000
	});
	await guest.close();
	expect(errors, 'host page errors').toEqual([]);
});
