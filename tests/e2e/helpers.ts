import { expect, type BrowserContext, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appPath } from './base';

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
	let lastErr: unknown;
	for (;;) {
		// `fn` is allowed to throw and we keep polling: reading the oracle races
		// onMount, so a snapshot taken in the moment after goto() resolves but
		// before the app has mounted hits an undefined `window.__syncstream`. That
		// is a poll that is not ready yet, not a failed condition -- and a poller
		// that dies on the first transient throw is flaky by construction, which
		// PLAN.md 8 is explicit is worse than having no test. A throw that never
		// stops still fails, at the deadline, carrying its own message.
		try {
			last = await fn();
			lastErr = undefined;
			if (pred(last)) return last;
		} catch (err) {
			lastErr = err;
		}
		if (Date.now() > deadline) {
			const detail = lastErr
				? `last error=${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
				: `last=${JSON.stringify(last)?.slice(0, 400)}`;
			throw new Error(
				`timed out after ${timeout}ms waiting for ${opts.what ?? 'condition'}; ${detail}`
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

/** Opens a room as host and stops at the picker, with no file chosen yet. */
export async function openRoom(page: Page) {
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto(appPath('/?debug=1'));
	await page.getByText('Create room').click();

	// The code renders straight from the URL, so it is visible long before
	// rendezvous confirms. The file picker only exists once the room is really
	// announced, which makes it the honest signal to wait on -- and reading the
	// code before that risks reading one a collision is about to replace.
	await expect(page.getByTestId('file-input')).toBeAttached({ timeout: 45_000 });
	const code = (await page.getByTestId('room-code').textContent())!.trim();
	return { code, errors };
}

/** Opens a room as host and picks a fixture. */
export async function openHost(page: Page, file: string) {
	const opened = await openRoom(page);
	await page.getByTestId('file-input').setInputFiles(fixture(file));
	return opened;
}

/**
 * Drags a file onto the page and drops it. Playwright has no drag-from-desktop
 * API, so the DataTransfer is built in the page and handed to real events --
 * which is also what makes this exercise the window-level listeners the picker
 * actually relies on, rather than a synthetic call into the component.
 */
export async function dropFile(page: Page, file: { name: string; type: string; body?: string }) {
	const dt = await page.evaluateHandle((f) => {
		const dt = new DataTransfer();
		dt.items.add(new File([f.body ?? 'not a video'], f.name, { type: f.type }));
		return dt;
	}, file);
	await page.dispatchEvent('body', 'dragenter', { dataTransfer: dt });
	await page.dispatchEvent('body', 'dragover', { dataTransfer: dt });
	await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
}

export async function openGuest(ctx: BrowserContext, code: string) {
	const page = await ctx.newPage();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	await page.goto(appPath(`/room/${code}?debug=1`));
	return { page, errors };
}

/**
 * Says who you are through the room's own name tag. Shared because naming a
 * peer is setup for any test whose claim is about the room's people: two
 * machine-generated names differing only in three digits make an assertion
 * about *which* person hard to trust.
 */
export async function nameYourself(page: Page, testid: string, name: string) {
	// The control is the fix. On unfixed source there is nothing to click, and
	// the room has no way at all to be told who is in it.
	await expect(
		page.getByTestId(`${testid}-edit`),
		'the room must let you say who you are'
	).toBeVisible({ timeout: 45_000 });
	await page.getByTestId(`${testid}-edit`).click();
	await page.getByTestId(`${testid}-field`).fill(name);
	await page.getByTestId(`${testid}-save`).click();
	await expect(page.getByTestId(`${testid}-name`)).toHaveText(name);
}

/**
 * The invite link the host would actually send someone, read off the page.
 *
 * This is the one string the product exists to produce, and it is built from
 * `paths.base` -- so on any non-root deploy it is also the first thing to break,
 * silently, in a way no other assertion here would notice.
 */
export const inviteLink = (page: Page): Promise<string> =>
	page.evaluate(async () => {
		const btn = document.querySelector<HTMLButtonElement>('[data-testid="copy-link"]');
		if (!btn) throw new Error('no copy-link button; the room never opened');
		btn.click();
		return navigator.clipboard.readText();
	});
