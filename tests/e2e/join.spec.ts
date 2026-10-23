import { expect, test } from '@playwright/test';
import { appPath } from './base';
import { freshRoom } from './helpers';

/**
 * The landing page is the only way into a room, and what a guest has been handed
 * is a link. The link carries the room's key (codes.ts) in its fragment, and a
 * code on its own has not opened a room since the key existed - so the box
 * takes a link, reads the room out of it, and says exactly what is wrong with
 * anything else.
 */

test('pasting the invite link the host copied joins that room, key included', async ({
	page,
	baseURL
}) => {
	const room = freshRoom();
	await page.goto(appPath('/'));
	const input = page.getByLabel('Invite link');

	// Exactly what lands on the clipboard from the room's copy button.
	await input.fill(`${baseURL}${appPath(`/room/${room.code}?s=local#k=${room.secret}`)}`);
	await expect(page.getByRole('button', { name: 'Join' })).toBeEnabled();
	await page.getByRole('button', { name: 'Join' }).click();

	// It used to keep the first six alphabet characters of the URL -- 'HTTPLC',
	// a valid-looking code for a room that does not exist, which the guest then
	// waited in forever with no error to explain it. Now the whole room goes
	// through: code in the path, key in the fragment.
	await expect(page).toHaveURL(new RegExp(`/room/${room.code}(\\?[^#]*)?#k=${room.secret}$`));
});

test('a link with no room in it says so instead of inventing one', async ({ page }) => {
	await page.goto(appPath('/'));
	const input = page.getByLabel('Invite link');

	await input.fill('https://example.com/watch/tonight');

	await expect(page.getByTestId('join-error')).toContainText('not an invite link');
	await expect(page.getByRole('button', { name: 'Join' })).toBeDisabled();
});

test('a link that lost its key is told apart from a link to nowhere', async ({ page }) => {
	// A chat client trimmed the fragment. The difference matters: "not a link"
	// means re-copy it, "missing its key" means ask the host for the whole thing.
	await page.goto(appPath('/'));
	const input = page.getByLabel('Invite link');

	await input.fill('https://example.com/SyncStream/room/K7M4PQ?s=nostr');

	await expect(page.getByTestId('join-error')).toContainText('lost its key');
	await expect(page.getByRole('button', { name: 'Join' })).toBeDisabled();
});

test('a bare code is not enough any more, and the box says so', async ({ page }) => {
	await page.goto(appPath('/'));
	const input = page.getByLabel('Invite link');

	await input.fill('K7M4PQ');
	await expect(page.getByRole('button', { name: 'Join' })).toBeDisabled();
	await input.press('Enter');
	await expect(page.getByTestId('join-error')).toBeVisible();
	await expect(page).toHaveURL(/\/$/);
});
