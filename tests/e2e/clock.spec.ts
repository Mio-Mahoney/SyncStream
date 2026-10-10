import { expect, test } from '@playwright/test';
import { openGuest, openHost, snapshot, until, videoTime } from './helpers';

/**
 * The host's wall clock and its monotonic clock are two different clocks, and
 * they drift apart for as long as the tab is open: every NTP correction and
 * every wake from sleep moves the first and not the second.
 *
 * The sync engine runs entirely on the monotonic one (clock.ts) - except that
 * the host answered pings with `Date.now()`. So a guest measured its offset
 * against the wall clock and applied it to `atHostClock`, which is monotonic,
 * and the whole of the host's wall-vs-monotonic gap became an error in every
 * guest's playhead.
 *
 * A minute of gap is used here because it cannot be mistaken for anything
 * else: on one machine the true offset between two tabs is a few milliseconds.
 */
test("a host whose wall clock has drifted does not drag its guests' playheads", async ({
	page,
	context
}) => {
	await page.addInitScript(() => {
		const real = Date.now.bind(Date);
		Date.now = () => real() + 60_000;
	});

	const { code } = await openHost(page, 'tiny-60s.mp4');
	const { page: guest } = await openGuest(context, code);
	await until(
		() => snapshot(guest),
		(s) => s.ttff !== null,
		{ what: 'first frame', timeout: 60_000 }
	);

	await page.getByTestId('play').click();
	const locked = await until(
		() => snapshot(guest),
		(s) => s.playing && s.rtt > 0 && s.mediaTime > 2,
		{ what: 'the guest to be playing with a measured clock', timeout: 30_000 }
	);

	// Two tabs of one browser share a clock, so anything past scheduling noise
	// here is the host reporting a different clock than the one it stamps
	// state with.
	expect(
		Math.abs(locked.clockOffset),
		"the offset must be measured against the host's sync clock, not its wall clock"
	).toBeLessThan(1000);

	const [host, follower] = await Promise.all([videoTime(page), videoTime(guest)]);
	expect(Math.abs(host - follower), 'guest and host playheads').toBeLessThan(1);
});
