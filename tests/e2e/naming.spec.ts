import { expect, test } from '@playwright/test';
import { nameYourself, openGuest, openHost, openRoom, snapshot, until } from './helpers';

/**
 * Nobody in this watch party had a name.
 *
 * Every screen that reports on the room was already built to render names, and
 * the wire has carried one on `hello` since Phase 2 - but they were all a
 * machine's guess: "Guest 412", and the literal string "Host". A host who sent
 * the link to three friends read "Guest 412 and Guest 500 are here" and could
 * not tell which two came.
 *
 * The room is where you say who you are, not the way in: the invite link opens
 * the room straight away by design, so a guest is already in it and already on
 * the host's presence line before anything could have asked them. That is what
 * the `rename` message is for, and it is what these tests are mostly about.
 */

test('a guest says who it is, and the room stops calling it a number', async ({
	page,
	context
}) => {
	const { code } = await openHost(page, 'tiny-60s.mp4');
	const [alice, bob] = await Promise.all([openGuest(context, code), openGuest(context, code)]);

	// Two guests racing a cold rendezvous is the slowest thing this file does, and
	// it is setup rather than the claim - so it is waited for on its own, and the
	// assertions below are about the sentence rather than the network. Folded
	// together, a guest that never arrived and a roster that rendered wrong failed
	// identically.
	//
	// Both said hello, not both connected: a link comes up before the guest on the
	// far end of it says anything, and `hello` is what carries the name. The
	// roster is built from the names, so a peer count is up to a round trip early
	// for it - the gate has to be the same fact the assertion reads.
	await until(
		() => snapshot(page),
		(s) => s.peers.length === 2 && s.peers.every((p) => /^Guest \d+$/.test(p.name)),
		{
			what: 'both guests to reach the host and say who they are',
			timeout: 60_000
		}
	);

	// Both are in and announced under the machine's fallback before either has
	// been asked anything - which is exactly the situation `rename` exists for.
	// A name read at join time could never fix this: by the time there is anyone
	// to read it, the room has already met them.
	await expect(page.getByTestId('guests')).toHaveText(/Guest \d+ and Guest \d+ are here\./);

	await nameYourself(alice.page, 'guest-name', 'Alice');

	// The host's line is the one this is for: it is what proves the link worked,
	// and it answered with a number nobody could match to a friend. Either order:
	// the list is in arrival order, and the two guests race to connect.
	await expect(page.getByTestId('guests'), 'the host must read the name a guest chose').toHaveText(
		/(Alice and Guest \d+|Guest \d+ and Alice) are here\./,
		{ timeout: 45_000 }
	);

	// And the other guest's roster, which is the half a rename could silently
	// miss: the host owns every name in the room, so a rename that updated only
	// the host's own line would leave Bob watching with a stranger forever. The
	// host is still unnamed here, so it is still "Host".
	await expect(bob.page.getByTestId('company'), 'a rename must reach the other guests').toHaveText(
		'Watching with Host and Alice.',
		{ timeout: 45_000 }
	);

	// Alice is never told her own name is in the room, for the reason the roster
	// excludes her: she is not somebody she is watching with.
	await expect(alice.page.getByTestId('company')).toHaveText(/Watching with Host and Guest \d+\./);

	expect(alice.errors, 'guest page errors').toEqual([]);
});

test('the host says who it is, and guests both here and yet to come hear it', async ({
	page,
	context
}) => {
	const { code } = await openRoom(page);
	// Already in the room, and reading the host's name off the hello it sent
	// before it had one - the roster is not sent until there is a film, so this
	// guest is precisely the one a rename could fail to reach.
	const early = await openGuest(context, code);
	await expect(early.page.getByTestId('waiting-room')).toContainText('Connected to Host.', {
		timeout: 45_000
	});

	await nameYourself(page, 'host-name', 'Mio');

	await expect(
		early.page.getByTestId('waiting-room'),
		'a guest already waiting must learn the host renamed itself'
	).toContainText('Connected to Mio.', { timeout: 45_000 });

	// And whoever turns up next meets the host under its real name, rather than
	// being introduced to "Host" and corrected later.
	const late = await openGuest(context, code);
	await expect(late.page.getByTestId('waiting-room')).toContainText('Connected to Mio.', {
		timeout: 45_000
	});

	expect(early.errors, 'guest page errors').toEqual([]);
});

test('a name is said once, not once per room', async ({ page }) => {
	await openRoom(page);
	await nameYourself(page, 'host-name', 'Mio');

	// A new room in the same browser is the same person. Without this the name
	// would be a per-room chore, which is worse than the fallback it replaces.
	await openRoom(page);
	await expect(page.getByTestId('host-name-name'), 'the room must remember who you are').toHaveText(
		'Mio'
	);
});

/**
 * The names in this file all arrive over the wire, and a guest is not a trusted
 * client: it is a browser someone else has the devtools for. The host is what
 * states every name to everyone else, so a name it takes at face value is not
 * one guest's problem - it is the whole room's presence line and roster.
 *
 * Forged at the transport rather than through the name tag, because the tag
 * normalises before it sends. The gap being tested is the wire, which the UI
 * cannot reach - so the test has to be the thing the UI is not.
 */
test('a name off the wire cannot wreck the room it lands in', async ({ page, context }) => {
	const { code } = await openHost(page, 'tiny-60s.mp4');

	const guest = await context.newPage();
	await guest.addInitScript(() => {
		const send = RTCDataChannel.prototype.send;
		RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: unknown) {
			if (typeof data === 'string' && data.includes('"t":"rename"')) {
				try {
					const m = JSON.parse(data);
					if (m?.t === 'rename') {
						m.name = 'x'.repeat(100_000);
						data = JSON.stringify(m);
					}
				} catch {
					// Not ours to fix: pass it on exactly as it was.
				}
			}
			return (send as (d: unknown) => void).call(this, data);
		};
	});
	await guest.goto(`/room/${code}?debug=1`);

	await until(
		() => snapshot(page),
		(s) => s.peers.length === 1 && /^Guest \d+$/.test(s.peers[0].name),
		{ what: 'the guest to reach the host and say who it is', timeout: 60_000 }
	);

	// Locally this is an ordinary rename to "Alice" - the tag says so. What
	// leaves the tab is 100,000 characters.
	await nameYourself(guest, 'guest-name', 'Alice');

	const named = await until(
		() => snapshot(page),
		(s) => !/^Guest \d+$/.test(s.peers[0]?.name ?? ''),
		{ what: 'the forged name to reach the host', timeout: 45_000 }
	);

	// NAME_MAX in identity.ts. Unbounded, this was every remaining screen in the
	// room: the host's presence line, the roster the host re-states to the other
	// guests, and the barrier's "Waiting for X to catch up".
	expect(
		named.peers[0].name.length,
		'the host must bound a name before it states it to the room'
	).toBeLessThanOrEqual(24);
	await expect(page.getByTestId('guests')).toHaveText(/^\s*x{1,24} is here\.$/);
});
