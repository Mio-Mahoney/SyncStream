import { expect, type BrowserContext, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = (name: string) => join(here, '..', 'fixtures', name);

export type Snapshot = {
	role: 'host' | 'guest' | null;
	room: string | null;
	strategy: string | null;
	iceState: string;
	candidateType: string;
	throughputBps: number;
	bufferedAhead: number;
	rtt: number;
	clockOffset: number;
	drift: number;
	rung: number | null;
	availableRungs: number[];
	segmentQueue: number;
	playing: boolean;
	mediaTime: number;
	tier: string | null;
	waitingOn: string[];
	peers: {
		peerId: string;
		name: string;
		role: string;
		bufferedAhead: number;
		rung: number | null;
	}[];
	ttff: number | null;
};

/** PLAN.md 8: the Phase 0 instrumentation is the oracle. */
export const snapshot = (page: Page): Promise<Snapshot> =>
	page.evaluate(() => window.__syncstream!.snapshot() as unknown as Snapshot);

/**
 * PLAN.md 8: no sleeps. Poll for the condition with an explicit deadline. A
 * flaky sync test is worse than no sync test because it trains you to ignore it.
 */
export async function until<T>(
	fn: () => Promise<T>,
	pred: (v: T) => boolean,
	opts: { timeout?: number; interval?: number; what?: string } = {}
): Promise<T> {
	const timeout = opts.timeout ?? 30_000;
	const interval = opts.interval ?? 100;
	const deadline = Date.now() + timeout;
	let last: T | undefined;
	for (;;) {
		last = await fn();
		if (pred(last)) return last;
		if (Date.now() > deadline) {
			throw new Error(
				`timed out after ${timeout}ms waiting for ${opts.what ?? 'condition'}; last=${JSON.stringify(last)?.slice(0, 400)}`
			);
		}
		await new Promise((r) => setTimeout(r, interval));
	}
}

/** PLAN.md 8's throttle, done where it actually works. bits/sec, null to lift. */
export const throttle = (page: Page, bitsPerSec: number | null) =>
	page.evaluate((bps) => window.__syncstream!.throttle(bps), bitsPerSec);

export const videoTime = (page: Page) =>
	page.evaluate(() => {
		const v = document.querySelector('video') as HTMLVideoElement | null;
		return v ? v.currentTime : -1;
	});

/** Opens a room as host and picks a fixture. */
export async function openHost(page: Page, file: string) {
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto('/?debug=1');
	await page.getByText('Create room').click();

	// The code renders straight from the URL, so it is visible long before
	// rendezvous confirms. The file picker only exists once the room is really
	// announced, which makes it the honest signal to wait on -- and reading the
	// code before that risks reading one a collision is about to replace.
	await expect(page.getByTestId('file-input')).toBeAttached({ timeout: 45_000 });
	const code = (await page.getByTestId('room-code').textContent())!.trim();

	await page.getByTestId('file-input').setInputFiles(fixture(file));
	return { code, errors };
}

export async function openGuest(ctx: BrowserContext, code: string) {
	const page = await ctx.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto(`/room/${code}?debug=1`);
	return { page, errors };
}
