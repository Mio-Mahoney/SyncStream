import { expect, test } from '@playwright/test';
import { appPath } from './base';

/**
 * The landing page is the only way into a room, and what a guest has been handed
 * is a link -- not a code. These cover the box accepting both.
 */

const CODE = 'K7M4PQ';

test('pasting the invite link the host copied joins that room', async ({ page, baseURL }) => {
	await page.goto(appPath('/'));
	const input = page.getByLabel('Room code');

	// Exactly what lands on the clipboard from the room header's copy button.
	await input.fill(`${baseURL}${appPath(`/?room=${CODE}&s=local`)}`);

	// It used to keep the first six alphabet characters of the URL -- 'HTTPLC',
	// a valid-looking code for a room that does not exist, which the guest then
	// waited in forever with no error to explain it.
	await expect(input).toHaveValue(CODE);

	// Joined at the address the link itself has, strategy included: the box is a
	// second way to open the link, not a way to open a lesser version of it. The
	// landing page here pins no strategy of its own, so `s` can only have come
	// from the paste.
	await page.getByRole('button', { name: 'Join' }).click();
	await expect(page).toHaveURL(new RegExp(`${appPath('/')}[?]room=${CODE}&s=local$`));
	await expect(page.getByTestId('room-code')).toHaveText(CODE);
});

test('a typed code joins at the invite address too', async ({ page }) => {
	// One address for a guest however they got in, and the one a static host
	// answers with a 200: a link copied out of this address bar is a working
	// invite with a preview card, the same as the one the host sent.
	await page.goto(appPath('/?s=local'));
	await page.getByLabel('Room code').fill(CODE);

	await page.getByRole('button', { name: 'Join' }).click();
	await expect(page).toHaveURL(new RegExp(`${appPath('/')}[?]room=${CODE}&s=local$`));
	await expect(page.getByTestId('room-code')).toHaveText(CODE);
});

test('the code is read from where the app would read it, not the first thing like it', async ({
	page
}) => {
	await page.goto(appPath('/'));
	const input = page.getByLabel('Room code');

	// A `/room/` earlier in the address is not the room: here it is a path
	// with nothing after it, and on some deploy it could be the base path.
	await input.fill(`https://example.com/room/?room=${CODE}`);
	await expect(input).toHaveValue(CODE);

	await input.fill(`https://example.com/room/app/?room=${CODE.toLowerCase()}`);
	await expect(input).toHaveValue(CODE);
});

test('a link to the room page itself is read the same way', async ({ page, baseURL }) => {
	await page.goto(appPath('/'));
	const input = page.getByLabel('Room code');

	// What a host's address bar shows, and the shape every invite had before the
	// code moved into the query. Both are still links people hold.
	await input.fill(`${baseURL}${appPath(`/room/${CODE}`)}`);

	await expect(input).toHaveValue(CODE);
});

test('a link with no room code in it says so instead of inventing one', async ({ page }) => {
	await page.goto(appPath('/'));
	const input = page.getByLabel('Room code');

	await input.fill('https://example.com/watch/tonight');

	await expect(input).toHaveValue('');
	await expect(page.getByTestId('join-error')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Join' })).toBeDisabled();
});

test('a code typed with stray punctuation and case is still accepted', async ({ page }) => {
	await page.goto(appPath('/'));
	const input = page.getByLabel('Room code');

	await input.fill('k7 m4-pq');

	await expect(input).toHaveValue('K7M4PQ');
	await expect(page.getByRole('button', { name: 'Join' })).toBeEnabled();
});
