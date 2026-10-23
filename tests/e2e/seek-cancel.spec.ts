import { expect, test } from '@playwright/test';
import { openGuest, openHost, snapshot, throttle, until, videoTime } from './helpers';

type Sent = Record<number, { chunks: number; total: number }>;

/**
 * PLAN.md Phase 2: a seek must not leave orphaned requests in flight.
 *
 * The guest has always said so - it sends `segCancel` for everything a seek
 * abandons - and the host had always ignored it, pushing each abandoned
 * segment to completion through the one constrained resource in the room,
 * alongside the segment the guest was now actually waiting for.
 *
 * Read off the wire rather than off a clock, because the claim is about bytes:
 * the guest's own outgoing `segCancel`s say which requests it gave up on, the
 * host's outgoing frames say how much of each it sent (wire.ts: a 13-byte
 * header of type, request id, chunk index, chunk count), and no request in the
 * first set may appear whole in the second.
 */
test('a seek stops the segments it abandoned instead of finishing them', async ({
	page,
	context
}) => {
	await page.addInitScript(() => {
		const sent: Record<number, { chunks: number; total: number }> = {};
		(window as unknown as { __sent: typeof sent }).__sent = sent;
		const send = RTCDataChannel.prototype.send;
		RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: never) {
			const frame = data as unknown;
			if (frame instanceof ArrayBuffer && frame.byteLength >= 13) {
				const view = new DataView(frame);
				const entry = (sent[view.getUint32(1)] ??= { chunks: 0, total: view.getUint32(9) });
				entry.chunks++;
			}
			return send.call(this, data);
		};
	});

	const { code, secret } = await openHost(page, 'tiny-60s.mp4');

	const guest = await context.newPage();
	await guest.addInitScript(() => {
		const cancelled: number[] = [];
		(window as unknown as { __cancelled: number[] }).__cancelled = cancelled;
		const send = RTCDataChannel.prototype.send;
		RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: never) {
			const text = data as unknown;
			if (typeof text === 'string' && text.includes('"segCancel"')) {
				cancelled.push((JSON.parse(text) as { reqId: number }).reqId);
			}
			return send.call(this, data);
		};
	});
	await openGuest(context, { code, secret }, undefined, guest);

	await until(
		() => snapshot(guest),
		(s) => s.ttff !== null,
		{ what: 'first frame', timeout: 60_000 }
	);

	// The barrier would hold the room for the guest we are about to starve.
	await page.getByLabel('Pause when someone falls behind').uncheck();

	// Slow enough that a segment takes seconds to send. A guest that has
	// landed somewhere keeps reading ahead, so by the time each seek below is
	// made there is a fetch in flight for the position it leaves.
	await throttle(page, 600_000);

	// Each target is in a different segment, and all are past what the guest
	// buffered before the throttle, so every seek is a fresh fetch.
	for (const t of [54, 40, 48, 44]) {
		await page.getByTestId('seek').fill(String(t));
		await page.getByTestId('seek').dispatchEvent('change');
		await until(
			() =>
				guest.evaluate(() => {
					const v = document.querySelector('video') as HTMLVideoElement;
					return { time: v.currentTime, landed: !v.seeking && v.readyState >= 2 };
				}),
			(v) => v.landed && Math.abs(v.time - t) < 1.5,
			{ what: `the guest to land the seek to ${t}s`, timeout: 90_000 }
		);
		await until(
			() => snapshot(guest),
			(s) => s.segmentQueue > 0,
			{ what: `the guest to be reading ahead from ${t}s`, timeout: 30_000 }
		);
	}
	expect(await videoTime(guest)).toBeGreaterThan(40);

	// Long enough for an ignored cancel to have run to completion: lift the cap
	// and anything the host is still sending finishes at once.
	await throttle(page, null);
	await until(
		() => snapshot(page),
		(s) => s.segmentQueue === 0,
		{ what: 'the host to finish what it is serving', timeout: 30_000 }
	);

	const cancelled = await guest.evaluate(
		() => (window as unknown as { __cancelled: number[] }).__cancelled
	);
	const sent = await page.evaluate(() => (window as unknown as { __sent: Sent }).__sent);
	expect(cancelled.length, 'the seeks must have abandoned something').toBeGreaterThan(0);

	const finishedAnyway = cancelled.filter((id) => sent[id] && sent[id].chunks >= sent[id].total);
	expect(
		finishedAnyway,
		`requests the guest cancelled that the host sent whole (cancelled: ${cancelled.join(', ')})`
	).toEqual([]);
});
