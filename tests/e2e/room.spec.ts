import { expect, test, type Page } from '@playwright/test';
import {
	fixture,
	openGuest,
	openHost,
	openRoom,
	snapshot,
	throttle,
	until,
	videoTime
} from './helpers';

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
 * The barrier's other half, and the one everybody hits: it holds the room open
 * before anyone has watched anything, because a guest arrives with an empty
 * buffer and that is simply the way in.
 *
 * Regression: it said the same thing there as it does for a mid-film stall, so
 * the first thing every new guest read - within a second of the host picking a
 * file, over a film that had never played a frame - was "Your connection fell
 * behind. The film starts again on its own once it catches up." Every clause of
 * that is false during the opening buffer, and it opens a watch party by
 * blaming the guest's connection for a stall that has not happened.
 *
 * The throttle is what makes the wait long enough to assert against rather than
 * a ~2s flicker. It goes on before the file, so it shapes the opening buffer -
 * which is the moment under test - rather than a recovery from it.
 */
test('a guest loading the opening is not told their connection fell behind', async ({
	page,
	context
}) => {
	const { code } = await openRoom(page);
	const { page: guest } = await openGuest(context, code);
	await until(
		() => snapshot(page),
		(s) => s.peers.length === 1,
		{
			what: 'the guest to reach the host',
			timeout: 60_000
		}
	);
	const guestName = (await snapshot(page)).peers[0].name;

	await throttle(page, 400_000);
	await page.getByTestId('file-input').setInputFiles(fixture('tiny-60s.mp4'));

	// The guest's half, and their first impression of the room. What the guest
	// must NOT be told leads, because that is the defect: these three are the
	// exact words the banner used to open a watch party with, and each one of
	// them is a claim about a stall that has not happened.
	const guestNotice = guest.getByTestId('waiting');
	await expect(guestNotice).toBeVisible({ timeout: 60_000 });
	await expect(guestNotice).not.toContainText('fell behind');
	await expect(guestNotice).not.toContainText('catch up');
	await expect(guestNotice).not.toContainText('starts again');
	await expect(guestNotice).toContainText('Still loading the film for you');
	await expect(guestNotice).toHaveAttribute('data-started', 'false');
	await expect(guestNotice).toHaveAttribute('data-you', 'true');
	// Pinned because it is how the fix could regress into passing trivially: the
	// banner must still be addressed to the guest, not withheld from them
	// because the honest wording was hard.
	await expect(guest.getByTestId('waiting-you')).toBeVisible();
	await expect(guestNotice).not.toContainText(guestName);

	// The host's half: "waiting for X to catch up" over a film nobody has played
	// reads as a friend with a bad connection, when it is the normal way in.
	const hostNotice = page.getByTestId('waiting');
	await expect(hostNotice).not.toContainText('catch up');
	await expect(hostNotice).toHaveText(new RegExp(`Still loading the film for ${guestName}\\.`));
	await expect(hostNotice).toHaveAttribute('data-started', 'false');

	// And it is only the pre-roll wording that changed: once the film has played
	// for this reader, a stall is a stall again.
	await throttle(page, null);
	await page.getByTestId('play').click();
	await until(
		() => videoTime(guest),
		(t) => t > 0.5,
		{ what: 'the guest to start playing' }
	);
	await expect(guestNotice).toBeHidden();
	await expect(hostNotice).toBeHidden();
	await throttle(page, 3_000_000);
	await until(
		() => snapshot(page),
		(s) => s.waitingOn.length > 0,
		{
			what: 'the barrier to trip again mid-film',
			timeout: 60_000
		}
	);
	await expect(guestNotice).toHaveAttribute('data-started', 'true');
	await expect(guestNotice).toContainText('fell behind');
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

/** How far the control bar runs past its own box. Anything over 0 is off the end. */
const barOverflow = (page: Page) =>
	page.evaluate(() => {
		const bar = document.querySelector('[data-testid="seek"]')!.parentElement!;
		return bar.scrollWidth - bar.clientWidth;
	});

const controlWidth = (page: Page, testid: string) =>
	page.evaluate(
		(id) =>
			Math.round(document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().width),
		testid
	);

/**
 * Regression: the bar was a single unwrapping row whose fixed parts needed
 * ~454px before the seek got a pixel, and the seek could not shrink under a
 * range input's ~129px intrinsic width. On a 390px phone that put the volume
 * slider and the fullscreen button past the right edge of a player that is
 * `overflow-hidden` -- so they were not scrolled off, they were gone, and
 * fullscreen is the one control on a phone worth having.
 */
test('every player control is reachable on a phone', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openHost(page, 'tiny-60s.mp4');
	await expect(page.getByTestId('video')).toBeVisible({ timeout: 45_000 });

	expect(await barOverflow(page)).toBe(0);
	for (const control of ['play', 'seek', 'elapsed', 'duration', 'mute', 'fullscreen']) {
		await expect(page.getByTestId(control)).toBeInViewport();
	}

	// Fitting by squeezing the seek to a sliver would pass the checks above and
	// still leave the film unscrubbable. On its own row it gets the full width.
	expect(await controlWidth(page, 'seek')).toBeGreaterThan(250);

	// The volume slider is what stands down to make that room: a phone has
	// hardware keys, and iOS ignores `video.volume` outright. Mute does not,
	// because the hardware keys have no equivalent.
	await expect(page.getByTestId('volume')).toBeHidden();
	await expect(page.getByTestId('mute')).toBeVisible();

	// The wide layout is the one that already worked, and it keeps everything.
	await page.setViewportSize({ width: 1280, height: 800 });
	expect(await barOverflow(page)).toBe(0);
	await expect(page.getByTestId('volume')).toBeVisible();
	await expect(page.getByTestId('fullscreen')).toBeInViewport();
});

/**
 * Regression: the room's chrome below the player was sliced in half by the fold
 * on an ordinary laptop.
 *
 * A 1080p film across the full 1024px of the room block is 576px tall, which
 * with the control bar, the header and the page's own padding put the player's
 * bottom edge at y=700 of a 720px window. Everything that lives beneath it began
 * at y=712: for a host, who is watching plus the invite link plus the only way
 * off a wrong film; for a guest, the roster naming the people they came to watch
 * with. All of it is built to be read while the film plays, and none of it was.
 *
 * `ratio: 1` is load-bearing. `toBeInViewport()` defaults to any intersection at
 * all, so it passed on the unfixed build off the 8px sliver of a 30px button -
 * the same too-weak-matcher trap as `toBeVisible` and fullscreen occlusion.
 *
 * 1280x720 is set explicitly rather than inherited: the defect is a relationship
 * between the film's height and the window's, so a config default that drifted
 * would silently stop testing it.
 */
test('the room fits a laptop window with the film playing', async ({ page, context }) => {
	await page.setViewportSize({ width: 1280, height: 720 });
	const { code } = await openHost(page, 'tiny-60s.mp4');
	await expect(page.getByTestId('change-video')).toBeVisible({ timeout: 45_000 });

	const height = (p: Page, testid: string) =>
		p.evaluate(
			(id) =>
				Math.round(document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().height),
			testid
		);
	const scrolls = (p: Page) =>
		p.evaluate(() => document.documentElement.scrollHeight > window.innerHeight);

	// Whole, not partly. Each of these is the host's only copy of its fact.
	for (const control of ['guests', 'change-video', 'copy-link', 'play', 'seek', 'fullscreen']) {
		await expect(
			page.getByTestId(control),
			`the host's ${control} must be whole on screen`
		).toBeInViewport({ ratio: 1 });
	}
	expect(await scrolls(page), 'nothing in a playing room should need scrolling to').toBe(false);

	// Fitting by shrinking the film to a strip would satisfy everything above and
	// ruin the one thing the page is for. It gives up the ~46px the bar needs and
	// no more: 530 of the 576 it would take unconstrained.
	expect(await height(page, 'video')).toBeGreaterThan(480);

	// The guest's half of the same fold. Their line is shorter than the host's
	// bar, so the film keeps more of its height here - which is the point of
	// sizing against the bar rather than against a number.
	const { page: guest } = await openGuest(context, code);
	await guest.setViewportSize({ width: 1280, height: 720 });
	await until(
		() =>
			guest.evaluate(() => (document.querySelector('video') as HTMLVideoElement)?.videoWidth ?? 0),
		(w) => w > 0,
		{ what: "the guest's film to have a shape to lay out", timeout: 60_000 }
	);
	await expect(
		guest.getByTestId('company'),
		'the guest roster must be whole on screen'
	).toBeInViewport({ ratio: 1 });
	expect(await scrolls(guest)).toBe(false);
	expect(await height(guest, 'video')).toBeGreaterThan(480);

	// A window with room to spare is not capped: the cap is a ceiling, not a size.
	await page.setViewportSize({ width: 1280, height: 1000 });
	await expect
		.poll(() => height(page, 'video'), { message: 'a tall window to render the film unshrunk' })
		.toBe(576);
});

/**
 * The barrier's banner is the only account anybody gets of a film that froze on
 * its own, and it was withheld from the one reader who most needed it.
 *
 * Fullscreen is how a film gets watched, and the fullscreen element is the
 * player. Everything outside that element is on a lower layer and is not
 * painted at all while it is up - and the banner was a sibling of the player,
 * so a guest who went fullscreen and then stalled got a black picture, a
 * stopped clock, and nothing whatsoever saying why or that it fixes itself.
 *
 * Containment in the fullscreen element is the assertion, because `toBeVisible`
 * cannot see this: it passed on the unfixed build, since the element still has
 * a layout box - it is simply never rendered.
 *
 * Same deterministic setup as the opening-buffer test above: throttle before
 * the file, so the barrier holds long enough to assert against.
 */
test('the barrier notice reaches a guest watching fullscreen', async ({ page, context }) => {
	const { code } = await openRoom(page);
	const { page: guest } = await openGuest(context, code);
	await until(
		() => snapshot(page),
		(s) => s.peers.length === 1,
		{ what: 'the guest to reach the host', timeout: 60_000 }
	);

	await throttle(page, 400_000);
	await page.getByTestId('file-input').setInputFiles(fixture('tiny-60s.mp4'));

	const notice = guest.getByTestId('waiting');
	await expect(notice).toBeVisible({ timeout: 60_000 });

	await guest.getByTestId('fullscreen').click();
	const fs = await guest.evaluate(() => {
		const el = document.fullscreenElement;
		const n = document.querySelector('[data-testid="waiting"]');
		return { entered: !!el, painted: !!(el && n && el.contains(n)) };
	});
	expect(fs.entered, 'the fullscreen button must actually enter fullscreen').toBe(true);
	expect(fs.painted, 'a stalled guest in fullscreen must be told why the film stopped').toBe(true);
	// The banner surviving fullscreen is worth nothing if it arrives wordless.
	await expect(notice).toContainText('Still loading the film for you');
	await expect(guest.getByTestId('waiting-you')).toBeVisible();
	await guest.evaluate(() => document.exitFullscreen());

	// The overlay spans the whole player so that it can centre in it, which puts
	// it over the control bar as well - so the bar has to stay clickable through
	// it. Asserted against the notice specifically rather than against "the play
	// button is on top", because `?debug=1` puts its own overlay on the page and
	// that is the harness, not the room.
	const hitByNotice = await guest.evaluate(() => {
		const play = document.querySelector('[data-testid="play"]')!.getBoundingClientRect();
		const hit = document.elementFromPoint(play.x + play.width / 2, play.y + play.height / 2);
		const notice = document.querySelector('[data-testid="waiting"]')!;
		return !!hit && (notice.contains(hit) || notice.parentElement === hit);
	});
	expect(hitByNotice, 'the notice must not shield the controls under it').toBe(false);

	// The other half of putting it on the film: the player is `overflow-hidden`,
	// which turns an overlay that does not fit into one that does not exist
	// (iteration 12's control bar), and a phone is where a stalled guest is most
	// likely to be sitting.
	await guest.setViewportSize({ width: 390, height: 844 });
	const clipped = await guest.evaluate(() => {
		const p = document.querySelector('.player')!.getBoundingClientRect();
		const n = document.querySelector('[data-testid="waiting"]')!.getBoundingClientRect();
		return n.top < p.top || n.bottom > p.bottom || n.left < p.left || n.right > p.right;
	});
	expect(clipped, 'the notice must not be clipped out of the player on a phone').toBe(false);
});
