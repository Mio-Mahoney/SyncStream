import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appPath, BUILD as build, ORIGIN } from './base';
import { DESCRIPTION } from '../../src/lib/copy';

const walk = (dir: string, out: string[] = []): string[] => {
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) walk(p, out);
		else out.push(p.slice(build.length + 1));
	}
	return out;
};

/**
 * PLAN.md 4.7: there is no server. This asserts the claim rather than trusting
 * it, because "no backend" is the property the whole cost argument rests on and
 * it is exactly the sort of thing that rots quietly when someone adds a route.
 */
test('the build is static files only, with no server entry point', () => {
	const files = walk(build);

	expect(files).toContain('index.html');

	// adapter-node emits index.js/handler.js; a Cloudflare Worker emits
	// _worker.js. None of these may ever appear here.
	const serverEntries = files.filter((f) =>
		/^(index\.js|handler\.js|_worker\.js|server\/|\.vercel|\.netlify)/.test(f)
	);
	expect(serverEntries, `found a server entry point in build/: ${serverEntries}`).toEqual([]);
});

test('deleted server dependencies are gone from the manifest', async () => {
	const pkg = await import('../../package.json', { with: { type: 'json' } });
	const deps = { ...pkg.default.dependencies, ...pkg.default.devDependencies };
	// PLAN.md 5 + 4.7: these are the shape of the old design.
	for (const gone of ['peerjs', 'peer', 'mongodb', '@sveltejs/adapter-node', 'ws']) {
		expect(Object.keys(deps), `${gone} should have been removed`).not.toContain(gone);
	}
});

test('the app loads with no backend process answering anything but static files', async ({
	page
}) => {
	const nonStatic: string[] = [];
	page.on('request', (r) => {
		const u = new URL(r.url());
		if (u.origin !== 'http://localhost:4173') return; // rendezvous relays are not ours
		if (r.method() !== 'GET') nonStatic.push(`${r.method()} ${u.pathname}`);
		if (u.pathname.startsWith('/api/')) nonStatic.push(`api ${u.pathname}`);
	});

	await page.goto(appPath('/'));
	await expect(page.getByRole('heading', { name: 'SyncStream' })).toBeVisible();
	expect(nonStatic, 'the app talked to a backend').toEqual([]);
});

/**
 * GitHub Pages has no rewrite rules: an unmatched path serves 404.html or
 * nothing, and Jekyll strips underscore-prefixed directories -- which is every
 * asset SvelteKit builds, all of them under _app/. Both failures are invisible
 * locally (vite preview rewrites happily, and runs no Jekyll) and produce a
 * blank page on the deployed site, so they are asserted against the build tree
 * rather than discovered after a push.
 */
test('the build carries what a rewrite-less static host needs', () => {
	const files = walk(build);
	expect(files, 'GitHub Pages serves 404.html for unmatched paths').toContain('404.html');
	expect(files, 'without .nojekyll, Pages strips the whole _app/ tree').toContain('.nojekyll');
	// Same shell, or a room link boots a different bundle than the landing page.
	const shell = readFileSync(join(build, 'index.html'), 'utf8');
	expect(readFileSync(join(build, '404.html'), 'utf8')).toBe(shell);
});

/**
 * A pasted link gets a preview card from whatever the crawler can read without
 * running a script, and nothing prerenders -- so the tags have to be in the
 * shell itself, where a `<svelte:head>` would never put them. The image is
 * checked against the build tree because a card pointing at a file that was
 * never emitted fails silently, in someone else's chat window.
 */
test('the shell carries link-preview tags a crawler can read without running it', () => {
	const shell = readFileSync(join(build, 'index.html'), 'utf8');
	const tag = (name: string): string | undefined =>
		new RegExp(`<meta\\s+(?:property|name)="${name}"\\s+content="([^"]*)"`).exec(shell)?.[1];

	expect(tag('og:title'), 'og:title').toBeTruthy();
	expect(shell, 'a large card needs twitter:card').toContain('name="twitter:card"');

	// The same sentence the landing page shows and the card image is drawn
	// with, from the one place it is written down (src/lib/copy.ts).
	expect(tag('og:description'), 'og:description').toBe(DESCRIPTION);
	expect(tag('description'), 'meta description').toBe(DESCRIPTION);
	expect(tag('og:image:alt'), 'og:image:alt').toContain(DESCRIPTION);
	expect(shell, 'a placeholder reached the shell unfilled').not.toMatch(/%app\.\w+%/);

	// The whole URL, not its tail. A crawler rejects a relative og:image, which
	// is what an unset origin leaves behind; the base path is what keeps it from
	// 404ing on a Pages project site; and the build is handed its origin with a
	// trailing slash (playwright.config.ts), which must not double up here.
	expect(tag('og:image'), 'og:image must be the absolute, base-prefixed URL').toBe(
		`${ORIGIN}${appPath('/og.png')}`
	);
	expect(walk(build), 'og:image points at a file the build did not emit').toContain('og.png');
});
