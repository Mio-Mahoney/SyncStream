import { appendFileSync, existsSync, statSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
	fixture,
	landedSeek,
	openGuest,
	openHost,
	peakRss,
	snapshot,
	until,
	videoTime
} from './helpers';

/**
 * PLAN.md Phase 2's acceptance criterion, at its stated scale.
 *
 * "With large-2gb.mp4, time-to-first-frame under 5s, seek to an arbitrary
 * timestamp resolves under 2s, peak RSS under 500MB on both sides, and playback
 * runs to completion on a LAN with zero stalls."
 *
 * This is the criterion the old build failed: it called readAsArrayBuffer on the
 * whole movie, so first frame cost a full transfer and both sides held the file
 * in JS heap. The numbers here are what section 11 records.
 *
 * Generate the fixture with: bash tests/fixtures/gen.sh --large
 */
const large = fixture('large-2gb.mp4');

/** One line per run, appended to a file the measurement script collects. */
function testInfoLog(line: string): void {
	const out = process.env.SCALE_LOG;
	if (!out) return;
	appendFileSync(out, `${new Date().toISOString()} ${line}\n`);
}

/**
 * The JS heap, kept beside the process figure because it is what the old
 * build blew up (gigabytes of file in heap), and because the two disagreeing
 * is itself information: media bytes live in ArrayBuffer backing stores and
 * workers, which the heap number does not count (REVIEW T-03). The
 * acceptance assertion is on the process.
 */
const heapMb = (page: Page) =>
	page.evaluate(() => {
		const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
		return m ? m.usedJSHeapSize / 1024 / 1024 : -1;
	});

test.describe(() => {
	test.skip(
		!existsSync(large),
		'needs tests/fixtures/large-2gb.mp4 (bash tests/fixtures/gen.sh --large)'
	);
	test.setTimeout(300_000);

	test('a multi-GB local file streams with a fast first frame and bounded memory', async ({
		page,
		browser
	}) => {
		const sizeGb = statSync(large).size / 1024 ** 3;
		// Separate contexts, as PLAN.md 11 states the measurement: Chromium gives
		// each its own renderer, so the memory of each side is read on its own.
		const guestContext = await browser.newContext();
		const rss = peakRss(browser);
		const { code, secret } = await openHost(page, 'large-2gb.mp4');
		const { page: guest } = await openGuest(guestContext, { code, secret });

		const first = await until(
			() => snapshot(guest),
			(s) => s.ttff !== null,
			{
				what: 'first frame from a multi-GB file',
				timeout: 120_000
			}
		);
		// Asserted below, after the measurements are logged: a run that misses
		// the bar is still a measurement, and the distribution is the point.

		await page.getByTestId('play').click();
		await until(
			() => videoTime(guest),
			(t) => t > 1,
			{ what: 'playback to advance' }
		);

		// Seek far into a file that was never uploaded anywhere. Landed, not
		// assigned: the frame is on screen when the clock stops.
		const target = 900;
		const seekMs = await landedSeek(guest, target);

		// Play through the seek for a while, so the memory peak includes a
		// working buffer on both sides rather than the first few segments.
		await until(
			() => videoTime(guest),
			(t) => t > target + 20,
			{ what: 'twenty seconds of playback past the seek', timeout: 60_000 }
		);
		const stalls = (await snapshot(guest)).stalls;
		const hostTimings = (await snapshot(page)).timings;
		const guestTimings = first.timings;

		const hostHeap = await heapMb(page);
		const guestHeap = await heapMb(guest);
		const { peak: peakRendererMb, top: renderers } = await rss.stop();

		const line = (k: string, v: string) => `  ${k.padEnd(22)}: ${v}`;
		console.log(
			[
				`\nPLAN.md 11 measurements (fixture ${sizeGb.toFixed(2)} GB):`,
				line('time to first frame', `${first.ttff!.toFixed(0)} ms (painted frame)`),
				line(`seek to ${target}s (landed)`, `${seekMs} ms`),
				line(
					'peak renderer RSS',
					`${peakRendererMb.toFixed(0)} MB (renderers at peak: ${renderers.map((m) => m.toFixed(0)).join(' / ')})`
				),
				line('host JS heap', `${hostHeap.toFixed(0)} MB`),
				line('guest JS heap', `${guestHeap.toFixed(0)} MB`),
				line('guest stalls', String(stalls)),
				line(
					'host probe / origin',
					`${hostTimings.probeMs ?? '-'} / ${hostTimings.originMs ?? '-'} ms`
				),
				line(
					'guest queue/create/load',
					`${guestTimings.readyToLoadMs ?? '-'} / ${guestTimings.createPlayerMs ?? '-'} / ${guestTimings.loadMs ?? '-'} ms`
				),
				line(
					'load -> data -> frame',
					`${guestTimings.loadToDataMs ?? '-'} / ${guestTimings.loadToFrameMs ?? '-'} ms`
				),
				line('host serve trace', (await snapshot(page)).fetchTrace.join(' | ')),
				line('guest fetch trace', first.fetchTrace.join(' | ')),
				''
			].join('\n')
		);
		testInfoLog(
			`ttff=${first.ttff!.toFixed(0)} seek=${seekMs} rss=${peakRendererMb.toFixed(0)} hostHeap=${hostHeap.toFixed(0)} guestHeap=${guestHeap.toFixed(0)} stalls=${stalls} probe=${hostTimings.probeMs ?? 0} origin=${hostTimings.originMs ?? 0} queue=${guestTimings.readyToLoadMs ?? 0} create=${guestTimings.createPlayerMs ?? 0} load=${guestTimings.loadMs ?? 0} toData=${guestTimings.loadToDataMs ?? 0} toFrame=${guestTimings.loadToFrameMs ?? 0} renderers=${renderers.map((m) => m.toFixed(0)).join('/')} guest="${first.fetchTrace.join(' | ')}" host="${(await snapshot(page)).fetchTrace.join(' | ')}"`
		);

		// PLAN.md Phase 2's criterion, each clause measured as it is stated.
		expect(first.ttff, 'time to first frame').toBeLessThan(5000);
		expect(seekMs, 'a landed seek deep into the file').toBeLessThan(2000);
		expect(peakRendererMb, 'peak process memory on the heavier side').toBeLessThan(500);
		expect(hostHeap, 'host JS heap must not scale with file size').toBeLessThan(500);
		expect(guestHeap, 'guest JS heap must not scale with file size').toBeLessThan(500);
		expect(stalls, 'playback past the seek must not stall').toBe(0);
		await guestContext.close();
	});
});
