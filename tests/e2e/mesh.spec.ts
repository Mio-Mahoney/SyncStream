import { existsSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { fixture, openGuest, openHost, snapshot, throttle, until, videoTime } from './helpers';

/**
 * PLAN.md Phase 5's acceptance criterion, run for the first time -- and the
 * measurement that showed it does not hold (PLAN.md §11).
 *
 * The arithmetic the criterion was built on: native is ~9.7 Mbps, so four
 * guests are ~39 Mbps of demand against a 12 Mbps host uplink, impossible
 * unless guests serve each other. What actually happens (telemetry,
 * 2026-07-21): the mesh moves tens of MB guest-to-guest during the startup
 * buffer fill, then goes silent. Phase 3 keeps every playhead synced and every
 * buffer equally full, so all four guests want segment N within the same
 * instant, and the announce coalesce (≤1s) plus a tracker round trip means no
 * guest's cache is ever a useful answer for another's next fetch. Each
 * estimator then reads only its ~3 Mbps share of the host uplink, no guest
 * ever selects native, no native segment enters the mesh, and the room
 * settles into a self-reinforcing 720p equilibrium: zero stalls, full
 * buffers, and a criterion the design cannot currently meet. Escaping it
 * needs designed fetch diversity (e.g. staggered lookahead or a leader that
 * pulls native for the room), which is Phase 5 work that does not exist yet.
 *
 * Throttling is the app's own uplink shaper: §11 records that CDP cannot
 * shape SCTP. Generate the fixture with: bash tests/fixtures/gen.sh --large
 */
const large = fixture('large-2gb.mp4');

const GUESTS = 4;
const HOST_UPLINK_BPS = 12_000_000;
/** Seconds of lockstep playback the room must hold in the passing test. */
const WINDOW_S = 30;

async function openRoomOfFour(
	page: Page,
	browser: { newContext(): Promise<BrowserContext> }
): Promise<{ guests: Page[]; contexts: BrowserContext[] }> {
	const { code } = await openHost(page, 'large-2gb.mp4');
	// Capped before anyone joins: the claim is about a 12 Mbps uplink, not
	// about a mesh warmed through a fat pipe.
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
	return { guests, contexts };
}

test.describe(() => {
	test.skip(
		!existsSync(large),
		'needs tests/fixtures/large-2gb.mp4 (bash tests/fixtures/gen.sh --large)'
	);
	// Five simultaneous 1080p pipelines on one machine.
	test.setTimeout(600_000);

	/**
	 * What the mesh and the room DO deliver under the criterion's load, locked
	 * in so it cannot regress: a 12 Mbps host carries four guests with zero
	 * stalls at a stable rung, the peer protocol moves real bytes without a
	 * single fallback, and the advertised ladder stays honest. This is the
	 * regression floor for whatever Phase 5 work later goes after native.
	 */
	test('four guests on a 12 Mbps uplink: zero stalls, and the mesh moves real bytes', async ({
		page,
		browser
	}) => {
		const { guests, contexts } = await openRoomOfFour(page, browser);
		await page.getByTestId('play').click();

		for (const [i, guest] of guests.entries()) {
			await until(
				() => snapshot(guest),
				(s) => s.playing && s.rung !== null,
				{ what: `guest ${i + 1} to be playing on a chosen rung`, timeout: 120_000 }
			);
		}

		// The lockstep window. Every guest must advance WINDOW_S of media in
		// ~WINDOW_S of wall clock: a rebuffer, or the readiness barrier pausing
		// the room for a starved guest, eats wall time that playback does not.
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

		const finals = await Promise.all(guests.map((g) => snapshot(g)));
		for (const [i, s] of finals.entries()) {
			expect(s.bufferedAhead, `guest ${i + 1} must not be running on fumes`).toBeGreaterThan(0);
			// The ladder invariant from the 2.1 fix, asserted here at scale too.
			expect(
				s.availableRungs,
				`guest ${i + 1}'s advertised rungs must be a contiguous prefix`
			).toEqual(s.availableRungs.map((_, j) => j));
		}

		// The peer path is real: bytes arrived guest-to-guest and were served
		// guest-to-guest (both sides of the same transfers), and not one peer
		// fetch was abandoned to the host mid-flight.
		const fromPeers = finals.reduce((sum, s) => sum + (s.mesh?.fromPeers ?? 0), 0);
		const uploaded = finals.reduce((sum, s) => sum + (s.mesh?.uploaded ?? 0), 0);
		const fallbacks = finals.reduce((sum, s) => sum + (s.mesh?.fallbacks ?? 0), 0);
		expect(fromPeers, 'the mesh must move real bytes guest-to-guest').toBeGreaterThan(0);
		expect(uploaded, 'some guest must have served what another received').toBeGreaterThan(0);
		expect(fallbacks, 'no peer fetch may be abandoned to the host').toBe(0);

		for (const ctx of contexts) await ctx.close();
	});

	/**
	 * The criterion itself, kept running and expected to fail: the day Phase 5
	 * work gives the room fetch diversity, this flips to "unexpected pass" and
	 * forces its own promotion to a plain test. Until then it fails in ~3
	 * minutes on the first guest that parks below native, which is the
	 * documented equilibrium above.
	 */
	test('PHASE 5 CRITERION (open): four guests hold native past the host uplink', async ({
		page,
		browser
	}) => {
		test.fail(true, 'the 720p equilibrium: see the header comment and PLAN.md §11');
		const { guests, contexts } = await openRoomOfFour(page, browser);
		await page.getByTestId('play').click();

		for (const [i, guest] of guests.entries()) {
			await until(
				() => snapshot(guest),
				(s) => s.rung === 0 && s.playing,
				{ what: `guest ${i + 1} to reach the native rung`, timeout: 180_000 }
			);
		}

		for (const ctx of contexts) await ctx.close();
	});
});
