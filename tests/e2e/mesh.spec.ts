import { existsSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { fixture, openGuest, openHost, snapshot, throttle, until, videoTime } from './helpers';

/**
 * PLAN.md Phase 5's acceptance criterion, and the measurement history behind
 * it (PLAN.md §11).
 *
 * The arithmetic the criterion was built on: native is ~9.7 Mbps, so four
 * guests are ~39 Mbps of demand against a 12 Mbps host uplink, impossible
 * unless guests serve each other. The first run (2026-07-21) showed the
 * reactive mesh could not meet it: Phase 3 keeps every playhead synced and
 * every buffer equally full, so all four guests want segment N within the
 * same instant, the announce coalesce (≤1s) plus a tracker round trip means
 * no guest's cache is ever a useful answer for another's next fetch, each
 * estimator reads only its ~3 Mbps share of the host uplink, and the room
 * parks in a self-reinforcing 720p equilibrium.
 *
 * The escape is the fetch-diversity prefetcher (mesh.ts, FETCH DIVERSITY):
 * the host deals each guest a stripe plus the room's rung set (`meshPlan`),
 * and each guest pulls its owned segments ahead of the room's aligned
 * fetches -- every playing rung first, so live traffic dedupes down to one
 * host copy, then rep 0, which is how native bytes enter the mesh before any
 * ABR selects native. That broke the equilibrium: the room stopped parking
 * at 720p, guests reach native, and the peer path moves real bytes with no
 * fallbacks. It did NOT get the room to hold native together, which is what
 * the criterion asks for and what the rewrite below finally measures.
 *
 * WHAT THE CRITERION ACTUALLY DEMANDS, and what this file used to check.
 * §7 says four guests "sustain native quality". The first version of the
 * criterion test below awaited `rung === 0` on each guest IN TURN, which is
 * a far weaker claim: it passes if each guest merely TOUCHES native at some
 * sampled instant, in any order, at any time within the timeout. Measured
 * coverage runs then showed the room does not settle at all -- the rung
 * vector across 18 samples at 10s intervals changed 16 times and spanned
 * every rung from 0 to 3 -- so a guest brushes native sooner or later
 * whether or not the mesh is carrying anything. The old test could pass on
 * that oscillation alone, and did not distinguish it from success. It is
 * therefore rewritten to require what §7 says: all four on native in the
 * SAME sample, then holding it together for NATIVE_HOLD_S with the film
 * actually advancing.
 *
 * The estimator is not the thing to reach for when this fails. A parked
 * guest was measured reading 3.6 Mbps against a 3.4 Mbps host link -- an
 * honest reading of its quarter-share, not blindness -- and making the
 * estimator more optimistic broke Phase 3 outright. See the note in
 * shaka/config.ts. What is missing is mesh COVERAGE, which measured ~17%
 * room-wide with prefetch consuming ~49% of all bytes pulled and returning
 * 0.36 bytes of peer service per byte spent. That is the open Phase 5 item.
 *
 * Throttling is the app's own uplink shaper: §11 records that CDP cannot
 * shape SCTP. Generate the fixture with: bash tests/fixtures/gen.sh --large
 */
const large = fixture('large-2gb.mp4');

const GUESTS = 4;
const HOST_UPLINK_BPS = 12_000_000;
/** Seconds of lockstep playback the room must hold in the passing test. */
const WINDOW_S = 30;

/** rep 0, the passthrough rung. "Native quality" in §7's acceptance wording. */
const NATIVE_RUNG = 0;

/**
 * Seconds all four guests must hold native TOGETHER. Matched to WINDOW_S so
 * the two tests measure over the same span: ~7 segments at the 4s target,
 * long enough that a rung the room is merely passing through cannot span it.
 */
const NATIVE_HOLD_S = 30;

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
	 * The criterion itself, asserting what §7 actually claims: not that each
	 * guest reaches native at some point of its own, but that the room holds
	 * native TOGETHER while the film runs. See this file's header for why the
	 * weaker per-guest form had to go.
	 *
	 * Both halves are load-bearing. Simultaneity is what makes the arithmetic
	 * bite -- four guests at ~9.5 Mbps against a 12 Mbps uplink is the
	 * impossible-without-the-mesh claim, and guests taking turns at native
	 * never tests it. The hold is what separates a room that settled there
	 * from one oscillating through it. Media time is checked across the
	 * window because `playing` is only `!video.paused`, which stays true
	 * through a stall: a room can hold native perfectly while advancing
	 * through none of the film.
	 */
	test('PHASE 5 CRITERION (open): four guests hold native past the host uplink', async ({
		page,
		browser
	}) => {
		// Open, and failing honestly. Measured 2026-07-21 against the strengthened
		// assertion above: the room never gets all four onto native in one
		// sample within 300s. Last state was
		// [{rung 2, est 2.7Mb}, {rung 2, est 2.8Mb}, {rung 1, est 6.0Mb},
		//  {rung 1, est 7.9Mb}] with coverage 18-30% and every buffer pegged at
		// 32-33s. No estimate is near the ~9.5 Mbps native needs, so no guest
		// selects it, and the mesh is carrying too little to change that. The
		// open work is mesh coverage (PLAN.md §11); when it lands this flips to
		// an unexpected pass and forces its own promotion to a plain test.
		test.fail(true, 'mesh coverage is ~20%; the room never holds native together (PLAN.md §11)');
		// Convergence is genuinely slow when it happens at all, and the hold
		// runs after it; the default would expire mid-measurement.
		test.setTimeout(900_000);
		const { guests, contexts } = await openRoomOfFour(page, browser);
		await page.getByTestId('play').click();

		/** Compact per-guest projection: the whole room in one readable line. */
		const room = async () =>
			(await Promise.all(guests.map((g) => snapshot(g)))).map((s) => ({
				rung: s.rung,
				estMb: Math.round(s.bandwidthEstimate / 1e5) / 10,
				buf: Math.round(s.bufferedAhead),
				covPct: s.mesh
					? Math.round((s.mesh.fromPeers / Math.max(1, s.mesh.fromPeers + s.mesh.fromHost)) * 100)
					: 0
			}));

		await until(room, (r) => r.every((g) => g.rung === NATIVE_RUNG), {
			what: 'all four guests to be on the native rung in the SAME sample',
			timeout: 300_000
		});

		// Held, not touched. Every sample across the window must still show the
		// whole room on native; the first one that does not is the failure, and
		// it reports the room's state rather than just a boolean.
		const before = await Promise.all(guests.map((g) => videoTime(g)));
		const heldFrom = Date.now();
		for (;;) {
			const elapsedMs = Date.now() - heldFrom;
			if (elapsedMs >= NATIVE_HOLD_S * 1000) break;
			const r = await room();
			expect(
				r.filter((g) => g.rung !== NATIVE_RUNG),
				`the room must HOLD native for ${NATIVE_HOLD_S}s, not merely touch it: ` +
					`a guest left native ${Math.round(elapsedMs / 1000)}s in, room=${JSON.stringify(r)}`
			).toEqual([]);
			await page.waitForTimeout(1000);
		}

		// And the film ran while they held it.
		const after = await Promise.all(guests.map((g) => videoTime(g)));
		for (const [i, t] of after.entries()) {
			expect(
				t - before[i],
				`guest ${i + 1} must advance through the hold window, not hold native while stalled`
			).toBeGreaterThan(NATIVE_HOLD_S * 0.8);
		}

		for (const ctx of contexts) await ctx.close();
	});
});
