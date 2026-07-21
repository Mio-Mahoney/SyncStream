import { expect, test } from '@playwright/test';
import { openGuest, openRoom, snapshot, until } from './helpers';

/**
 * The one spec that still crosses the public relay ladder (PLAN.md 4.6).
 *
 * Every other spec pins its rooms to the localhost relay, because a public
 * Nostr relay's bad minute is not a regression in this codebase. But the
 * ladder is the product's reliability argument, and an untested fallback is
 * not a fallback -- so this walks it for real, end to end: host announces on
 * the public strategies, guest finds the host and the control-channel hello
 * lands both ways. No media; the transport above rendezvous is the same one
 * every local-relay spec exercises.
 */

// The exception to the suite's retries: 0. This spec's dependency on shared
// public infrastructure is its subject, and a relay hiccup is expected a few
// percent of the time. A real ladder regression fails all three attempts;
// only relay weather passes on a clean retry. Do not widen timeouts instead
// -- that hides the weather without surviving it.
test.describe.configure({ retries: 2 });

test('the public relay ladder still carries a room end to end', async ({ page, context }) => {
	// 'nostr' is the ladder's own first rung, so this is exactly the production
	// default -- stated explicitly because the helpers otherwise pin to 'local'.
	const { code, errors: hostErrors } = await openRoom(page, { strategy: 'nostr' });
	const { page: guest, errors: guestErrors } = await openGuest(context, code, {
		strategy: 'nostr'
	});

	// The guest read the host's hello: rendezvous found a common relay and the
	// control channel opened.
	await expect(guest.getByTestId('waiting-room')).toHaveAttribute('data-phase', 'found', {
		timeout: 60_000
	});

	// And the host read the guest's: the peer stops being a default-role
	// placeholder only when the reply lands, which is the exact half of the
	// handshake that public-relay weather used to drop.
	await until(
		() => snapshot(page),
		(s) => s.peers.some((p) => p.role === 'guest'),
		{ what: "the guest's hello to reach the host", timeout: 60_000 }
	);

	const s = await snapshot(guest);
	expect(
		['nostr', 'mqtt'],
		'the room rendezvoused over a public strategy, not the test relay'
	).toContain(s.strategy);

	expect(hostErrors.concat(guestErrors), 'page errors').toEqual([]);
});
