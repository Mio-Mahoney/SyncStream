import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appPath } from './base';

const build = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'build');

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
