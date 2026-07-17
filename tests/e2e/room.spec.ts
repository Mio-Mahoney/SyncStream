import { expect, test } from '@playwright/test';
import { openGuest, openHost, snapshot, throttle, until, videoTime } from './helpers';

/**
 * PLAN.md Phase 2's acceptance criterion, at fixture scale.
 *
 * The plan states it against large-2gb.mp4 (time-to-first-frame under 5s, seek
 * under 2s). tiny-60s.mp4 is committed and 2GB is not, so this runs the same
 * assertions against the committed fixture; tests/fixtures/gen.sh --large
 * produces the real thing for the full-scale run.
 */
test('a guest joins and plays the host local file, in sync', async ({ page, context }) => {
	const { code, errors: hostErrors } = await openHost(page, 'tiny-60s.mp4');

	const { page: guest, errors: guestErrors } = await openGuest(context, code);

	// The guest must reach a first frame without the host uploading the file.
	const ready = await until(
		() => snapshot(guest),
		(s) => s.ttff !== null,
		{
			what: 'the guest to render a first frame',
			timeout: 60_000
		}
	);
	expect(ready.ttff, 'time to first frame').toBeLessThan(5000);
	expect(ready.role).toBe('guest');

	// The transport is what the plan replaced PeerJS for.
	const link = await until(
		() => snapshot(guest),
		(s) => s.iceState === 'connected' || s.iceState === 'completed',
		{
			what: 'ICE to connect'
		}
	);
	// PLAN.md 9: this is the measurement that decides TURN.
	expect(['host', 'srflx', 'prflx', 'relay']).toContain(link.candidateType);

	await page.getByTestId('play').click();

	// Both sides actually advance.
	await until(
		() => videoTime(guest),
		(t) => t > 1,
		{ what: 'the guest playhead to advance' }
	);
	await until(
		() => videoTime(page),
		(t) => t > 1,
		{ what: 'the host playhead to advance' }
	);

	// PLAN.md Phase 3: the host is the authority and the guest follows its clock.
	const synced = await until(
		() => snapshot(guest),
		(s) => s.playing && Math.abs(s.drift) < 0.5,
		{ what: 'the guest to lock onto the host clock' }
	);
	expect(Math.abs(synced.drift), 'drift once locked').toBeLessThan(0.5);
	expect(synced.rtt).toBeGreaterThan(0);

	expect(hostErrors, 'host page errors').toEqual([]);
	expect(guestErrors, 'guest page errors').toEqual([]);
});

test('a guest seek resolves quickly and both sides land together', async ({ page, context }) => {
	const { code } = await openHost(page, 'tiny-60s.mp4');
	const { page: guest } = await openGuest(context, code);
	await until(
		() => snapshot(guest),
		(s) => s.ttff !== null,
		{
			what: 'first frame',
			timeout: 60_000
		}
	);

	await page.getByTestId('play').click();
	await until(
		() => videoTime(guest),
		(t) => t > 1,
		{ what: 'playback to start' }
	);

	// A guest sends intent; the host decides and broadcasts (PLAN.md 4.9).
	const started = Date.now();
	await guest.getByTestId('seek').fill('40');
	await guest.getByTestId('seek').dispatchEvent('change');

	await until(
		() => videoTime(guest),
		(t) => t > 38 && t < 50,
		{
			what: 'the guest to land on the seek target',
			timeout: 20_000
		}
	);
	expect(Date.now() - started, 'seek latency').toBeLessThan(10_000);

	// The host followed its own guest's intent, which is the authority model working.
	await until(
		() => videoTime(page),
		(t) => t > 38 && t < 50,
		{
			what: 'the host to follow the intent'
		}
	);
});

/**
 * PLAN.md Phase 3's acceptance: "A deliberate 3 Mbps throttle on one guest trips
 * the barrier and the room recovers cleanly when it lifts."
 *
 * The plan says to apply that throttle with CDP Network.emulateNetworkConditions
 * (section 8). That does not work -- CDP does not shape WebRTC at all (measured:
 * 233 Mbps through a channel capped at 1.5 Mbps). We shape the host's own send
 * path instead, which is what a constrained uplink physically is.
 */
test('a throttled guest trips the readiness barrier, and lifting it recovers', async ({
	page,
	context
}) => {
	const { code } = await openHost(page, 'tiny-60s.mp4');
	const { page: guest } = await openGuest(context, code);
	await until(
		() => snapshot(guest),
		(s) => s.ttff !== null,
		{
			what: 'first frame',
			timeout: 60_000
		}
	);
	const guestName = (await snapshot(page)).peers[0]?.name;
	expect(guestName, 'the host knows the guest by name before the barrier trips').toMatch(
		/^Guest \d+$/
	);

	await throttle(page, 3_000_000);
	await page.getByTestId('play').click();

	// Starving the guest below 1s of buffer must stop the room and name who it
	// is waiting for, rather than letting that guest silently desync.
	const tripped = await until(
		() => snapshot(page),
		(s) => s.waitingOn.length > 0,
		{
			what: 'the barrier to trip on the throttled guest',
			timeout: 60_000
		}
	);
	// Regression: this asserted only that the list was non-empty, which the bug it
	// was meant to catch passed with flying colours. The barrier reports names, and
	// the host looked those names up in a map keyed by peer id -- so every lookup
	// missed and the banner read "Waiting for a guest" no matter who it waited for.
	expect(tripped.waitingOn, 'the host names who it waits for').toContain(guestName);
	await expect(page.getByTestId('waiting')).toHaveText(
		new RegExp(`Waiting for ${guestName} to catch up`)
	);

	// The guest's half. "Waiting for Guest 412" is the one sentence Guest 412
	// cannot act on, because nothing ever told them that is their name -- so the
	// person whose stall froze the film read it as news about someone else.
	const guestNotice = guest.getByTestId('waiting');
	await expect(guestNotice).toHaveAttribute('data-you', 'true');
	await expect(guestNotice).toContainText('Waiting for you to catch up');
	await expect(guestNotice).not.toContainText(guestName!);
	await expect(guest.getByTestId('waiting-you')).toBeVisible();
	// The host is never one of the guests the barrier waits on.
	await expect(page.getByTestId('waiting')).toHaveAttribute('data-you', 'false');

	// Recovery is the half that is easy to get wrong: the room must un-stick
	// itself once the guest catches up, with no user action.
	await throttle(page, null);
	await until(
		() => snapshot(page),
		(s) => s.waitingOn.length === 0,
		{
			what: 'the room to recover once the throttle lifts',
			timeout: 60_000
		}
	);
	await until(
		() => videoTime(guest),
		(t) => t > 0.5,
		{ what: 'the guest to resume playing' }
	);
	// Both notices clear. A banner telling a guest they are behind, left up over a
	// film that is playing again, is the shape of bug iteration 8 found on the
	// unplayable path: a one-way announcement with no "never mind" is a latch.
	await expect(guestNotice).toBeHidden();
	await expect(page.getByTestId('waiting')).toBeHidden();
});

/**
 * The host learns the duration from the file it opened, and a guest is told it
 * over the wire. Regression: the host only ever read it from `timeupdate`,
 * which does not fire until playback starts, so the total showed 0:00 and the
 * seek bar was pinned to max=0 -- the host could not scrub to a starting point
 * without first playing from the top.
 */
test('the host can scrub before playing anything', async ({ page }) => {
	await openHost(page, 'tiny-60s.mp4');
	await expect(page.getByTestId('video')).toBeVisible({ timeout: 45_000 });

	await expect(page.getByTestId('duration')).toHaveText('1:00');
	await expect(page.getByTestId('seek')).toHaveAttribute('max', '60');
	await expect(page.getByTestId('seek')).toBeEnabled();

	// Nothing has played, so this is a seek from a standing start.
	expect(await videoTime(page)).toBe(0);
	await page.getByTestId('seek').fill('30');
	await page.getByTestId('seek').dispatchEvent('change');

	await until(
		() => videoTime(page),
		(t) => t >= 29 && t <= 31,
		{
			what: 'the host to land on the scrubbed position without playing first'
		}
	);
	await expect(page.getByTestId('elapsed')).toHaveText('0:30');
});

/** The video, not the button, is what a viewer is looking at. */
test('keyboard shortcuts drive playback', async ({ page }) => {
	await openHost(page, 'tiny-60s.mp4');
	await expect(page.getByTestId('video')).toBeVisible({ timeout: 45_000 });
	const paused = () => page.evaluate(() => document.querySelector('video')!.paused);

	await page.getByTestId('video').click();
	await page.keyboard.press(' ');
	await until(paused, (p) => !p, { what: 'space to start playback' });

	await page.keyboard.press(' ');
	await until(paused, (p) => p, { what: 'space to pause again' });

	const before = await videoTime(page);
	await page.keyboard.press('ArrowRight');
	await until(
		() => videoTime(page),
		(t) => t >= before + 4,
		{
			what: 'ArrowRight to skip forward'
		}
	);

	await page.keyboard.press('m');
	expect(await page.evaluate(() => document.querySelector('video')!.muted)).toBe(true);
});
