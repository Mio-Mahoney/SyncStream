import { expect, test } from '@playwright/test';
import { dropFile, fixture, openHost, openRoom, snapshot, until } from './helpers';

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

	// Opening it scrolls it into view; this only guards against that regressing
	// into a measurement of a picker nobody could see anyway.
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

/**
 * The picker opens under the film, and a film fills the window, so it mounts
 * below the fold. Measured on unfixed source at this exact viewport: the picker's
 * top landed at y=744 in a 720px window. The host clicked the only control that
 * gets them off a wrong film, the button relabelled itself, and nothing else on
 * screen moved - so the click read as dead and the picker they had just asked for
 * was as hidden as it was before the control existed.
 */
test('asking to change the film brings the picker into view', async ({ page }) => {
	// The defect is a relationship between the player's height and the window's,
	// so the window is part of the test rather than a default it inherits.
	await page.setViewportSize({ width: 1280, height: 720 });
	const { errors } = await openHost(page, 'tiny-60s.mp4');
	await expect(page.getByTestId('video')).toBeVisible();

	await page.getByTestId('change-video').click();
	await expect(page.getByTestId('file-picker')).toBeVisible();

	// The scroll is smooth, so where the page ends up is not knowable from the
	// click returning. Poll for it landing rather than sampling once.
	const rects = () =>
		page.evaluate(() => {
			const p = document.querySelector('[data-testid="file-picker"]')!.getBoundingClientRect();
			const v = document.querySelector('[data-testid="video"]')!.getBoundingClientRect();
			return {
				pickerTop: Math.round(p.top),
				pickerBottom: Math.round(p.bottom),
				filmBottom: Math.round(v.bottom),
				windowHeight: window.innerHeight
			};
		});
	const seen = await until(rects, (m) => m.pickerBottom <= m.windowHeight, {
		what: 'the picker to be scrolled into view',
		timeout: 10_000
	});

	expect(
		seen.pickerTop,
		'the picker the host just asked for must be on screen'
	).toBeGreaterThanOrEqual(0);
	expect(
		seen.pickerBottom,
		'all of it, including the box a file is dropped on'
	).toBeLessThanOrEqual(seen.windowHeight);
	// The reason it opens below the player rather than in place of it: the film
	// everyone else is still watching must survive the host considering a
	// replacement. Scrolling it off screen to reach the picker would undo that.
	expect(seen.filmBottom, 'the film must still be on screen above it').toBeGreaterThan(0);
	expect(errors, 'host page errors').toEqual([]);
});

test('picking a file is reported once, at the picker it was handed to', async ({ page }) => {
	// The defect is a relationship between a page-top line and the picker
	// 250px below it, so the window has to be a known size rather than whatever
	// the config last defaulted to.
	await page.setViewportSize({ width: 1280, height: 720 });

	// Reading the file takes as long as it takes, so a single sample after the
	// pick races the probe and would report the screen it happens to land on.
	// This records every frame the picker is up: the history either contains the
	// second announcement or it does not.
	await page.addInitScript(() => {
		const w = window as unknown as { __rec?: boolean; __frames?: string[] };
		w.__frames = [];
		const tick = () => {
			requestAnimationFrame(tick);
			if (!w.__rec) return;
			const picker = document.querySelector('[data-testid="file-picker"]');
			if (!picker) return;
			const elsewhere = [...document.querySelectorAll('main *')]
				.filter((el) => !picker.contains(el) && el.children.length === 0)
				.map((el) => el.textContent?.trim() ?? '')
				.filter((t) => /reading|loading/i.test(t));
			w.__frames!.push(
				JSON.stringify({
					top: Math.round(picker.getBoundingClientRect().top),
					elsewhere,
					// What the picker said about itself this frame. Recorded rather
					// than polled from the test: it exists only while the file is being
					// read, so asking for it afterwards is a race against the probe and
					// asking for it from outside can only ever catch the frame it lands
					// on. The history answers both.
					chosen: document.querySelector('[data-testid="chosen-file"]')?.textContent ?? null
				})
			);
		};
		requestAnimationFrame(tick);
	});

	await openRoom(page);
	await page.evaluate(() => ((window as unknown as { __rec: boolean }).__rec = true));

	await page.getByTestId('file-input').setInputFiles(fixture('tiny-60s.mp4'));

	await until(
		() => page.getByTestId('video').isVisible(),
		(v) => v,
		{ what: 'the film to start' }
	);

	const frames = (
		await page.evaluate(() => (window as unknown as { __frames: string[] }).__frames)
	).map((f) => JSON.parse(f) as { top: number; elsewhere: string[]; chosen: string | null });

	// The precondition for everything below, and the honest version of a frame
	// count: the two claims after this are both about what the screen did while
	// the file was being read, so they mean nothing unless a frame caught it
	// being read. A threshold on how many frames a probe happens to fit in was
	// only ever standing in for this, and asked for four when the answer was
	// three.
	const reading = frames.filter((f) => f.chosen !== null);
	expect(reading.length, 'the picker must have been caught reading at all').toBeGreaterThan(0);

	// The picker speaks for itself while it reads: a spinner, and the name of the
	// file it was just handed.
	expect(
		[...new Set(reading.map((f) => f.chosen))],
		'the picker names the file it was handed, the whole time it holds it'
	).toEqual(['tiny-60s.mp4']);

	// Nothing outside the picker narrates the read. The page used to print
	// "Reading the file..." at the top while the picker showed a spinner and the
	// filename, saying one fact twice and saying it worse the second time.
	const doubled = frames.flatMap((f) => f.elsewhere);
	expect(doubled, 'the read must be announced only by the picker').toEqual([]);

	// ...and because that line appeared out of nothing at the top of the page, it
	// shoved the picker down 40px at the exact moment the host committed to a
	// file - the box they had just dropped on moving out from under the pointer.
	const tops = [...new Set(frames.map((f) => f.top))];
	expect(tops, 'the picker must not move when it is handed a file').toHaveLength(1);
});
