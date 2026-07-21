import { existsSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { fixture, openGuest, openHost, snapshot, throttle, until, videoTime } from './helpers';

/**
 * PLAN.md Phase 5's acceptance criterion, never before run: "a room of four
 * guests with the host's uplink capped at 12 Mbps, all four sustaining the
 * native rung with zero stalls".
 *
 * The arithmetic that makes this a mesh proof and not a bandwidth test: native
 * is ~9.7 Mbps, so four guests are ~39 Mbps of sustained demand against a
 * 12 Mbps host uplink. If every segment came from the host, the room would
 * starve three times over; it can only hold native if guests serve each other.
 * The mesh oracle (stats.mesh, wired through the guest status tick) is how the
 * peer-to-peer path is observed rather than assumed.
 *
 * Throttling is the app's own uplink shaper, not CDP: PLAN.md 11 records that
 * CDP does not touch SCTP (measured 233 Mbps through a 1.5 Mbps "cap"), and
 * the host's uplink is exactly the number being modelled anyway.
 *
 * Generate the fixture with: bash tests/fixtures/gen.sh --large
 */
const large = fixture('large-2gb.mp4');

const GUESTS = 4;
const HOST_UPLINK_BPS = 12_000_000;
/** Seconds of lockstep playback the room must hold once everyone is at native. */
const WINDOW_S = 30;

test.describe(() => {
	test.skip(
		!existsSync(large),
		'needs tests/fixtures/large-2gb.mp4 (bash tests/fixtures/gen.sh --large)'
	);
	// Five simultaneous 1080p pipelines on one machine; this is an integration
	// test at the plan's stated scale, not a unit test.
	test.setTimeout(600_000);

	test('four guests hold native past the host uplink, served by each other', async ({
		page,
		browser
	}) => {
		const { code } = await openHost(page, 'large-2gb.mp4');

		// Capped before anyone joins: the criterion is that the room works on a
		// 12 Mbps uplink, not that the mesh helps once a fat pipe warmed it.
		await throttle(page, HOST_UPLINK_BPS);

		const contexts: BrowserContext[] = [];
		const guests: Page[] = [];
		for (let i = 0; i < GUESTS; i++) {
			const ctx = await browser.newContext();
			contexts.push(ctx);
			const { page: guest } = await openGuest(ctx, code);
			guests.push(guest);
			// Staggered joins, as real guests are: a simultaneous four-way
			// rendezvous stampede tests the relay, not the mesh.
			await until(
				() => snapshot(guest),
				(s) => s.ttff !== null,
				{ what: `guest ${i + 1} of ${GUESTS} to reach first frame`, timeout: 120_000 }
			);
		}

		await page.getByTestId('play').click();

		// ABR measures its way up: Shaka's initial estimate is conservative, so a
		// guest may open below native and climb as fetches land. The criterion is
		// about sustaining native, so the stall clock starts once everyone is on
		// rung 0 and playing.
		for (const [i, guest] of guests.entries()) {
			await until(
				() => snapshot(guest),
				(s) => s.rung === 0 && s.playing,
				{ what: `guest ${i + 1} to reach the native rung`, timeout: 180_000 }
			);
		}

		// The measurement window. Every guest must advance WINDOW_S of media in
		// ~WINDOW_S of wall clock: a rebuffer, or the readiness barrier pausing
		// the room for a starved guest, eats wall time that playback does not,
		// and the elapsed check is what turns that into a failure.
		const before = await Promise.all(guests.map((g) => videoTime(g)));
		const t0 = Date.now();
		await until(
			async () => {
				const times = await Promise.all(guests.map((g) => videoTime(g)));
				return Math.min(...times.map((t, i) => t - before[i]));
			},
			(advanced) => advanced >= WINDOW_S,
			{ what: 'every guest to advance through the window', timeout: (WINDOW_S + 60) * 1000 }
		);
		const elapsedS = (Date.now() - t0) / 1000;
		expect(
			elapsedS,
			'zero stalls: the window must pass in real time, not stretched by rebuffers or barrier pauses'
		).toBeLessThan(WINDOW_S + 8);

		// Still native at the end of the window, for all four -- not a downshift
		// the window happened to survive.
		const finals = await Promise.all(guests.map((g) => snapshot(g)));
		for (const [i, s] of finals.entries()) {
			expect(s.rung, `guest ${i + 1} must end the window on the native rung`).toBe(0);
			expect(s.bufferedAhead, `guest ${i + 1} must not be running on fumes`).toBeGreaterThan(0);
		}

		// The mesh path, observed rather than assumed: bytes that reached a guest
		// from a peer, and bytes a guest served. Both sides of the same transfers,
		// so both must be non-zero if the mesh carried anything at all.
		const fromPeers = finals.reduce((sum, s) => sum + (s.mesh?.fromPeers ?? 0), 0);
		const uploaded = finals.reduce((sum, s) => sum + (s.mesh?.uploaded ?? 0), 0);
		expect(
			fromPeers,
			'at least one segment must have arrived guest-to-guest, or the mesh did nothing'
		).toBeGreaterThan(0);
		expect(uploaded, 'some guest must have served what another received').toBeGreaterThan(0);

		for (const ctx of contexts) await ctx.close();
	});
});
