import { expect, test } from '@playwright/test';
import { openGuest, openHost, snapshot, until, videoTime } from './helpers';

/**
 * The host decides what is playable in its own browser, for a file only it
 * has, and a guest's browser may disagree. The case on record is HEVC: native
 * on the host's machine, absent on the guest's.
 *
 * What happens then is not what was feared. The guest's player drops the
 * representation it cannot decode when it loads the manifest, and what is left
 * is the H.264 ladder the host encodes for slow links - so the guest is served
 * a rung it can play, and reaches a first frame. This pins that down, because
 * nothing else did: every other spec runs both ends in one browser, where the
 * two can never disagree.
 *
 * The guest here is one that says it cannot decode HEVC, through both of the
 * questions a player asks. A decoder that claims support and then fails is a
 * different failure and is not what this covers.
 */
test('a guest that cannot decode the native rung is served one it can', async ({
	page,
	context
}) => {
	const { code, secret } = await openHost(page, 'hevc.mp4');
	// The premise: HEVC plays natively on the host, so its native rung is HEVC.
	await until(
		() => snapshot(page),
		(s) => s.tier === 'direct',
		{ what: 'the host to probe the file as directly playable', timeout: 45_000 }
	);

	const guest = await context.newPage();
	await guest.addInitScript(() => {
		const hevc = /hvc1|hev1/;
		const supported = MediaSource.isTypeSupported.bind(MediaSource);
		MediaSource.isTypeSupported = (type: string) => !hevc.test(type) && supported(type);
		const capabilities = navigator.mediaCapabilities;
		const decodingInfo = capabilities.decodingInfo.bind(capabilities);
		capabilities.decodingInfo = async (config: MediaDecodingConfiguration) =>
			hevc.test(config.video?.contentType ?? '')
				? ({
						supported: false,
						smooth: false,
						powerEfficient: false
					} as MediaCapabilitiesDecodingInfo)
				: decodingInfo(config);
	});
	await openGuest(context, { code, secret }, undefined, guest);

	const first = await until(
		() => snapshot(guest),
		(s) => s.ttff !== null && s.rung !== null,
		{ what: 'the guest to render a first frame', timeout: 60_000 }
	);
	expect(first.rung, 'the guest must be on an encoded rung, not the native one').toBeGreaterThan(0);

	await page.getByTestId('play').click();
	await until(
		() => videoTime(guest),
		(t) => t > 1,
		{ what: 'the guest playhead to advance', timeout: 30_000 }
	);
	const synced = await until(
		() => snapshot(guest),
		(s) => s.playing && Math.abs(s.drift) < 0.5,
		{ what: 'the guest to lock onto the host clock', timeout: 30_000 }
	);
	expect(synced.rung).toBeGreaterThan(0);
});
