import { expect, test } from '@playwright/test';

/**
 * The landing page is the only way into a room, and what a guest has been handed
 * is a link -- not a code. These cover the box accepting both.
 */

const CODE = 'K7M4PQ';

test('pasting the invite link the host copied joins that room', async ({ page, baseURL }) => {
	await page.goto('/');
	const input = page.getByLabel('Room code');

	// Exactly what lands on the clipboard from the room header's copy button.
	await input.fill(`${baseURL}/room/${CODE}`);

	// It used to keep the first six alphabet characters of the URL -- 'HTTPLC',
	// a valid-looking code for a room that does not exist, which the guest then
	// waited in forever with no error to explain it.
	await expect(input).toHaveValue(CODE);

	await page.getByRole('button', { name: 'Join' }).click();
	await expect(page).toHaveURL(new RegExp(`/room/${CODE}$`));
});

test('a link with no room code in it says so instead of inventing one', async ({ page }) => {
	await page.goto('/');
	const input = page.getByLabel('Room code');

	await input.fill('https://example.com/watch/tonight');

	await expect(input).toHaveValue('');
	await expect(page.getByTestId('join-error')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Join' })).toBeDisabled();
});

test('a code typed with stray punctuation and case is still accepted', async ({ page }) => {
	await page.goto('/');
	const input = page.getByLabel('Room code');

	await input.fill('k7 m4-pq');

	await expect(input).toHaveValue('K7M4PQ');
	await expect(page.getByRole('button', { name: 'Join' })).toBeEnabled();
});
