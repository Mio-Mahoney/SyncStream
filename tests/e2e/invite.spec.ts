import { expect, test } from '@playwright/test';
import { openGuest, openHost, openRoom } from './helpers';

/**
 * The host's side of the wait. A room with no one in it is not a watch party,
 * so getting the link out and learning that it worked is the whole job of the
 * screen the host lands on.
 *
 * Neither job ends when the film does start, which is what the playback-time
 * tests at the bottom are for: the invite and the presence line used to get
 * quietly worse at exactly that moment.
 */

/** The refusal every browser hands out for an unfocused or insecure page. */
const refuseClipboard = (page: import('@playwright/test').Page) =>
	page.addInitScript(() => {
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: () => Promise.reject(new DOMException('Document is not focused.'))
			}
		});
	});

/** What the browser has actually selected, which is what Ctrl+C would take. */
const selection = (page: import('@playwright/test').Page) =>
	page.evaluate(() => {
		const el = document.activeElement as HTMLInputElement | null;
		return el?.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0) ?? '';
	});

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
	await refuseClipboard(page);
	await openRoom(page);

	await page.getByTestId('copy-link').click();

	await expect(page.getByTestId('copy-manual')).toBeVisible();
	await expect(page.getByTestId('copy-link')).toHaveText('Copy');
	// The fallback the message tells them to use has to actually be in place.
	expect(await selection(page)).toContain('/room/');
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

test('the host can still invite someone once the film is playing', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	const { code, errors } = await openHost(page, 'tiny-60s.mp4');

	// The invite panel is gone by now; the bar under the player carries it. A
	// latecomer is the normal case, not an edge case.
	await expect(page.getByTestId('copy-link')).toBeVisible({ timeout: 45_000 });
	await page.getByTestId('copy-link').click();
	await expect(page.getByTestId('copy-link')).toHaveText('Copied');
	expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`/room/${code}`);
	expect(errors, 'host page errors').toEqual([]);
});

test('a clipboard refused during playback reveals the link instead of throwing', async ({
	page
}) => {
	// The corner button this replaced had no catch and no link on screen behind
	// it, so a refusal was an uncaught "Document is not focused." in the console
	// and absolutely nothing on the page -- with the film already running and
	// people to invite to it.
	await refuseClipboard(page);
	const { errors } = await openHost(page, 'tiny-60s.mp4');

	await expect(page.getByTestId('copy-link')).toBeVisible({ timeout: 45_000 });
	await page.getByTestId('copy-link').click();

	await expect(page.getByTestId('copy-manual')).toBeVisible();
	// Compact keeps the field out of the bar until it is the only way through.
	await expect(page.getByTestId('invite-link')).toHaveValue(/\/room\//);
	expect(await selection(page)).toContain('/room/');
	expect(errors, 'host page errors').toEqual([]);
});

test('the host sees who is watching by name while the film plays', async ({ page, context }) => {
	const { code, errors } = await openHost(page, 'tiny-60s.mp4');
	await expect(page.getByTestId('guests')).toHaveText(/No one has joined yet/, { timeout: 45_000 });

	const { page: guest } = await openGuest(context, code);

	// Not "1 watching". The count made the host trust a number; the name is the
	// same fact with the evidence attached, and it is the one the panel already
	// gave them before playback started.
	await expect(page.getByTestId('guests')).toHaveText(/Guest \d+ is here/, { timeout: 45_000 });
	await guest.close();
	expect(errors, 'host page errors').toEqual([]);
});

test('a guest watching alone with the host is told so, and never named to itself', async ({
	page,
	context
}) => {
	const { code } = await openHost(page, 'tiny-60s.mp4');
	const { page: guest, errors } = await openGuest(context, code);

	// The mirror of the host's line above, and the half that was missing: with the
	// film up, a guest's entire page was the room code and a clock.
	const company = guest.getByTestId('company');
	await expect(company).toHaveText(/Watching with Host\./, { timeout: 45_000 });

	// The one name that may never appear here is the reader's own: nothing in the
	// app ever tells a guest which "Guest NNN" they are, so their own name reads
	// as one more stranger in the room. This guest is the only guest, so any
	// "Guest NNN" at all is theirs.
	await expect(company).not.toHaveText(/Guest \d+/);
	expect(errors, 'guest page errors').toEqual([]);
});

test('a guest is told about the guests it is not meshed with', async ({ page, context }) => {
	const { code } = await openHost(page, 'tiny-60s.mp4');
	const guests = await Promise.all([
		openGuest(context, code),
		openGuest(context, code),
		openGuest(context, code)
	]);

	// Three, deliberately, and this is the assertion that needs them. The mesh
	// links guests to each other opportunistically, so a roster built from a
	// guest's own peers undercounts the room - measured here, two guests saw all
	// three peers and the third permanently saw two, and was told it was watching
	// with two people while three watched. Two guests would not catch that: they
	// almost always mesh to each other, so a peer-derived roster looks correct
	// right up to the party that is big enough to matter.
	//
	// Every guest is connected to the host by definition, so the host's count is
	// the room's. Each reader sees the host plus the two guests who are not them,
	// which nameList renders as "and 1 other".
	for (const { page: g } of guests) {
		await expect(g.getByTestId('company')).toHaveText(
			/Watching with Host, Guest \d+ and 1 other\./,
			{
				timeout: 45_000
			}
		);
	}

	// And it is a roster, not a greeting: someone leaving has to leave it.
	await guests[2].page.close();
	for (const { page: g } of guests.slice(0, 2)) {
		await expect(g.getByTestId('company')).toHaveText(/Watching with Host and Guest \d+\./, {
			timeout: 45_000
		});
	}
});
