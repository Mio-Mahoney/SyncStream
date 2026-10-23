import { expect, test } from '@playwright/test';
import { fixture, openGuest, openHost, snapshot, until, videoTime } from './helpers';

/**
 * The project's one sentence: the people you invite can watch the film with
 * you, and when they can't, they are told why. Everything here is a failure
 * that used to be silent, or worse than silent - told to the wrong person, or
 * told in a way that took a working film down with it. Each one now travels
 * as a `Fault` (protocol/control), renders through FaultNotice, and is found
 * by the cause it carries rather than by matching prose.
 */

const playing = async (p: Parameters<typeof videoTime>[0], what: string) => {
	const was = await videoTime(p);
	await until(
		() => videoTime(p),
		(t) => t > was + 0.5,
		{ what, timeout: 30_000 }
	);
};

/**
 * REVIEW F-06 + F-07. A second file that probes fine and then cannot be built
 * used to tear the first film down *before* finding out: the running origin
 * was closed, every guest's player errored out, the host's element lost its
 * source, and a late joiner was handed a dead origin under the new title. Now
 * the new origin is built first, and nothing moves until it exists.
 */
test("a second film that can't be built leaves the first playing, and says so everywhere", async ({
	page,
	context
}) => {
	const { code, secret } = await openHost(page, 'tiny-60s.mp4');
	const { page: guest } = await openGuest(context, { code, secret });
	await until(
		() => snapshot(guest),
		(s) => s.ttff !== null,
		{ what: 'the guest to play the first film', timeout: 60_000 }
	);
	await page.getByTestId('play').click();
	await playing(guest, 'the guest to be watching');

	// A fragmented MP4: the probe now names it (F-07), and the host never got
	// as far as touching the film that is on.
	await page.getByTestId('change-video').click();
	await page.getByTestId('file-input').setInputFiles(fixture('fragmented.mp4'));

	const hostNotice = page.getByTestId('unplayable');
	await expect(hostNotice).toBeVisible({ timeout: 30_000 });
	await expect(hostNotice).toHaveAttribute('data-fault', 'container');
	await expect(hostNotice).toContainText('fragmented');
	await expect(page.getByTestId('unplayable-remedy')).toContainText('ffmpeg');

	// The guest is told the switch did not happen - beside the film, which is
	// still on - and is not shown the rejection as if their film had failed.
	const guestNote = guest.getByTestId('switch-failed');
	await expect(guestNote).toBeVisible({ timeout: 30_000 });
	await expect(guestNote).toHaveAttribute('data-fault', 'container');
	await expect(guestNote).toContainText('fragmented.mp4');
	await expect(guest.getByTestId('waiting-room')).toHaveCount(0);
	await expect(guest.getByTestId('error')).toHaveCount(0);

	// And the first film kept playing, on both ends, with no page errors.
	await playing(guest, 'the guest to still be watching the first film');
	await playing(page, 'the host to still be watching the first film');
	// The oracle's `tier` is the verdict on the last file offered, which was
	// the rejection; the film on is named by the title.
	expect((await snapshot(page)).tier).toBe('reject');
	await expect(page.getByTestId('host-now-playing')).toHaveAttribute('data-title', 'tiny-60s.mp4');
	await expect(guest.getByTestId('guest-now-playing')).toHaveAttribute(
		'data-title',
		'tiny-60s.mp4'
	);

	// A late joiner gets the film that is actually on.
	const { page: late } = await openGuest(context, { code, secret });
	await until(
		() => snapshot(late),
		(s) => s.ttff !== null,
		{ what: 'a late joiner to play the film that stayed on', timeout: 60_000 }
	);
	await expect(late.getByTestId('guest-now-playing')).toHaveAttribute('data-title', 'tiny-60s.mp4');
	await expect(late.getByTestId('switch-failed')).toHaveCount(0);
});

/**
 * REVIEW F-05. A renamed copy of the same file emits an identical manifest,
 * and the guest used to take the host's `ready` for a repeat of the film it
 * was already playing - so the host watched the new film under its new name
 * while every guest kept the old title. A film has an identity now, not just a
 * manifest.
 */
test('a renamed copy of the same file is a new film to the guest too', async ({
	page,
	context
}) => {
	const { code, secret } = await openHost(page, 'tiny-60s.mp4');
	const { page: guest } = await openGuest(context, { code, secret });
	await until(
		() => snapshot(guest),
		(s) => s.ttff !== null,
		{ what: 'the guest to play the first film', timeout: 60_000 }
	);

	await page.getByTestId('change-video').click();
	await page.getByTestId('file-input').setInputFiles({
		name: 'renamed-copy.mp4',
		mimeType: 'video/mp4',
		buffer: await import('node:fs/promises').then((fs) => fs.readFile(fixture('tiny-60s.mp4')))
	});

	await expect(page.getByTestId('host-now-playing')).toHaveAttribute(
		'data-title',
		'renamed-copy.mp4',
		{
			timeout: 30_000
		}
	);
	await expect(guest.getByTestId('guest-now-playing')).toHaveAttribute(
		'data-title',
		'renamed-copy.mp4',
		{ timeout: 30_000 }
	);
	await until(
		() => snapshot(guest),
		(s) => s.ttff !== null,
		{ what: 'the guest to reach a first frame of the new film', timeout: 60_000 }
	);
});

/**
 * REVIEW F-08. A guest whose player cannot load the film kept reporting an
 * empty buffer, so the readiness barrier held the whole room for it and every
 * other screen read "Waiting for Sam to catch up" about a stall no connection
 * could end. The guest said nothing to the host; the guest's own screen said
 * "this browser can't play the format" and nothing about what format.
 *
 * The guest here is one whose MediaSource accepts nothing at all, which is
 * what a browser with none of the stream's codecs looks like to Shaka.
 */
test("a guest whose browser can't play the film is named to the host, not waited for", async ({
	page,
	context
}) => {
	const { code, secret } = await openHost(page, 'tiny-60s.mp4');

	const cannot = await context.newPage();
	// Both questions a player asks, as codec-asymmetry.spec.ts shims them: Shaka
	// prefers `decodingInfo` where it exists and falls back to `isTypeSupported`.
	await cannot.addInitScript(() => {
		MediaSource.isTypeSupported = () => false;
		navigator.mediaCapabilities.decodingInfo = async () =>
			({ supported: false, smooth: false, powerEfficient: false }) as MediaCapabilitiesDecodingInfo;
	});
	await openGuest(context, { code, secret }, undefined, cannot);
	const { page: can } = await openGuest(context, { code, secret });

	// The host reads the fault, by name, and the room does not wait.
	const notice = page.getByTestId('cannot-play');
	await expect(notice).toBeVisible({ timeout: 60_000 });
	await expect(notice).toHaveAttribute('data-fault', 'unsupported-here');
	await expect(notice).toContainText(/Guest \d+'s browser can't play this video/);
	const host = await until(
		() => snapshot(page),
		(s) => s.peers.length === 2 && s.peers.some((p) => p.cannotPlay),
		{ what: 'the host to mark the guest that cannot play', timeout: 30_000 }
	);
	expect(host.waitingOn, 'the barrier must not hold the room for them').not.toContain(
		host.peers.find((p) => p.cannotPlay)!.name
	);

	// The guest who can play is unaffected: the room plays for them.
	await until(
		() => snapshot(can),
		(s) => s.ttff !== null,
		{ what: 'the other guest to reach a first frame', timeout: 60_000 }
	);
	await page.getByTestId('play').click();
	await playing(can, 'the other guest to be watching');
	expect((await snapshot(page)).waitingOn).toEqual([]);

	// The guest who cannot is told so, with the cause and something to try.
	await expect(cannot.getByTestId('error')).toContainText(/can't play|unsupported|codec|format/i);
});
