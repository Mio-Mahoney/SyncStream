import { expect, test } from '@playwright/test';
import { dropFile, openHost, openRoom, snapshot, until } from './helpers';

/**
 * Handing the room a file is the host's first move, and dragging one in from a
 * file manager is how people give a local file to a web page. The drop is taken
 * anywhere in the window rather than only on the box, so these drive `body`.
 */

test('a video dropped anywhere on the page reaches the probe', async ({ page }) => {
	const { errors } = await openRoom(page);

	// The bytes are not a real MP4, so the probe rejects it -- which is the
	// point: only the drop wiring can carry a file from the window to the probe,
	// so a message that could only come from the probe proves the wiring.
	await dropFile(page, { name: 'movie.mp4', type: 'video/mp4' });

	const probed = await until(
		() => snapshot(page),
		(s) => s.tier !== null,
		{
			what: 'the dropped file to be probed',
			timeout: 30_000
		}
	);
	expect(probed.tier).toBe('reject');
	await expect(page.getByTestId('unplayable')).toContainText('moov');
	expect(errors, 'host page errors').toEqual([]);
});

test('dragging a file over the page says where it can be dropped', async ({ page }) => {
	await openRoom(page);
	await expect(page.getByTestId('drop-overlay')).toBeHidden();

	const dt = await page.evaluateHandle(() => {
		const dt = new DataTransfer();
		dt.items.add(new File(['x'], 'movie.mp4', { type: 'video/mp4' }));
		return dt;
	});
	await page.dispatchEvent('body', 'dragenter', { dataTransfer: dt });
	await expect(page.getByTestId('drop-overlay')).toBeVisible();

	await page.dispatchEvent('body', 'dragleave', { dataTransfer: dt });
	await expect(page.getByTestId('drop-overlay')).toBeHidden();
});

/**
 * A non-video is answered by name, without reading a byte of it. The probe
 * would eventually reject it too, but only after pulling up to ~40MB off disk
 * to say something vaguer than "that is not a video".
 */
test('dropping a non-video is refused by name, and the picker stays', async ({ page }) => {
	await openRoom(page);

	await dropFile(page, { name: 'notes.txt', type: 'text/plain' });

	await expect(page.getByTestId('unplayable')).toContainText('"notes.txt" is not a video file.');
	await expect(page.getByTestId('file-picker')).toBeVisible();
	expect((await snapshot(page)).tier, 'the probe must not have run').toBeNull();
});

/**
 * The rejection has to be wherever the picker is. Once the picker could also
 * open below a playing film, the message stayed in a banner at the top of the
 * page: 710px above the picker, and with the picker scrolled into view to be
 * used at all, 282px above the top of the viewport. The host dropped a bad file
 * onto the box, the screen did not change, and the picker read as dead.
 */
test('a file rejected mid-film is explained at the picker, not off screen', async ({ page }) => {
	const { errors } = await openHost(page, 'tiny-60s.mp4');
	await expect(page.getByTestId('video')).toBeVisible();

	// The host decides the film is wrong and asks for the picker back.
	await page.getByTestId('change-video').click();
	const picker = page.getByTestId('file-picker');
	await expect(picker).toBeVisible();

	// The picker opens below the player, so a real host scrolls to it to use it.
	await picker.scrollIntoViewIfNeeded();
	await dropFile(page, { name: 'notes.txt', type: 'text/plain' });

	const notice = page.getByTestId('unplayable');
	await expect(notice).toContainText('"notes.txt" is not a video file.');

	// Their attention is on the box they just dropped onto. Whatever the page has
	// to say about that drop has to be readable from there without hunting for it.
	await picker.scrollIntoViewIfNeeded();
	const seen = await page.evaluate(() => {
		const n = document.querySelector('[data-testid="unplayable"]')!.getBoundingClientRect();
		const p = document.querySelector('[data-testid="file-picker"]')!.getBoundingClientRect();
		return {
			onScreen: n.top >= 0 && n.bottom <= window.innerHeight,
			gapPx: Math.round(p.top - n.bottom)
		};
	});
	expect(seen.onScreen, 'the reason the drop failed must be on screen with the picker').toBe(true);
	expect(seen.gapPx, 'the reason must sit against the picker it is about').toBeLessThan(100);

	// Backing out finishes with the rejection: reopening must not hang it back up
	// over a film the host already chose to keep.
	await page.getByTestId('change-video').click();
	await expect(picker).toBeHidden();
	await page.getByTestId('change-video').click();
	await expect(page.getByTestId('unplayable')).toBeHidden();
	expect(errors, 'host page errors').toEqual([]);
});
