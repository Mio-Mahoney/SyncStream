import { expect, test } from '@playwright/test';
import { dropFile, openRoom, snapshot, until } from './helpers';

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
