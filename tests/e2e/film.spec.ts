import { expect, test, type Page } from '@playwright/test';
import { fixture, openGuest, openHost, snapshot, until } from './helpers';

/**
 * The room could account for every person in it and never once said what was on.
 * A guest's whole page was "Room RHBGFD / 0:00 / 1:00 / Watching with Host." -
 * everybody present, and no mention of the only reason they came.
 */

/** The name the room reports, or null if no screen carries one. */
const nowPlaying = (p: Page, testid: string) =>
	p.evaluate(
		(id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('data-title') ?? null,
		testid
	);

test('the room says what it is watching, to both ends of it', async ({ page, context }) => {
	const { code } = await openHost(page, 'tiny-60s.mp4');

	// Deliberately after the host has picked. The title rides on `ready`, which a
	// latecomer only gets in reply to its hello - so a title captured when the
	// file was chosen, rather than read at send time, would leave every guest who
	// arrives once the film is on watching an unnamed one. That is most guests.
	const { page: guest } = await openGuest(context, code);
	await until(
		() => snapshot(guest),
		(x) => x.ttff !== null,
		{
			what: 'the guest to be playing the film',
			timeout: 60_000
		}
	);

	expect(await nowPlaying(guest, 'guest-now-playing')).toBe('tiny-60s.mp4');
	expect(await nowPlaying(page, 'host-now-playing')).toBe('tiny-60s.mp4');

	// The host's copy has a second job: "Change video" opens a picker reading
	// "Drop a video here" and nothing said which film it would replace. So the
	// name has to be on screen with that control, not merely somewhere.
	const bar = page.getByTestId('host-now-playing');
	await expect(bar).toBeInViewport({ ratio: 1 });
	const gap = await page.evaluate(() => {
		const t = document.querySelector('[data-testid="host-now-playing"]')!.getBoundingClientRect();
		const b = document.querySelector('[data-testid="change-video"]')!.getBoundingClientRect();
		return Math.abs(b.top - t.bottom);
	});
	expect(gap).toBeLessThan(100);
});

test('a second film renames the room, on both ends', async ({ page, context }) => {
	const { code } = await openHost(page, 'tiny-60s.mp4');
	const { page: guest } = await openGuest(context, code);
	await until(
		() => snapshot(guest),
		(x) => x.ttff !== null,
		{
			what: 'the guest to be playing the first film',
			timeout: 60_000
		}
	);
	expect(await nowPlaying(guest, 'guest-now-playing')).toBe('tiny-60s.mp4');

	await page.getByTestId('change-video').click();
	await page.getByTestId('file-input').setInputFiles(fixture('no-audio.mp4'));

	// Both ends, because they fail apart: the host reads its own file's name and
	// would be right no matter what the wire did, while the guest is told - so a
	// name that never crossed on the second `ready` leaves only the guest wrong,
	// watching a film the room calls something else.
	await until(
		() => nowPlaying(page, 'host-now-playing'),
		(t) => t === 'no-audio.mp4',
		{
			what: 'the host to report the film it just put on',
			timeout: 30_000
		}
	);
	await until(
		() => nowPlaying(guest, 'guest-now-playing'),
		(t) => t === 'no-audio.mp4',
		{
			what: 'the guest to be told the film changed',
			timeout: 60_000
		}
	);
});

test('a file the host cannot play never renames the film that is on', async ({ page }) => {
	await openHost(page, 'tiny-60s.mp4');
	await expect(page.getByTestId('host-now-playing')).toHaveAttribute('data-title', 'tiny-60s.mp4');

	await page.getByTestId('change-video').click();
	await page.getByTestId('file-input').setInputFiles(fixture('gen.sh'));

	// The rejection displaced nothing: the film everyone is watching is still the
	// one they were watching, and the room must keep calling it by its name rather
	// than by the name of a file it refused.
	await expect(page.getByTestId('unplayable')).toBeVisible();
	expect(await nowPlaying(page, 'host-now-playing')).toBe('tiny-60s.mp4');
});
