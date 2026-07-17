/**
 * Duplicates the SPA shell to the filenames each static host looks for.
 *
 * `adapter-static` emits exactly one HTML file (`index.html`, the fallback --
 * nothing prerenders), and every route boots from it. Hosts disagree on how to
 * serve it for a path that has no file of its own, which is every room URL:
 *
 * - Cloudflare Pages / Netlify read `static/_redirects` and rewrite to the
 *   shell. Nothing needed here.
 * - GitHub Pages has no rewrite rules at all. Its only SPA hook is that an
 *   unmatched path serves `404.html`, so the shell has to exist under that name
 *   too. The status line reads 404 while the page works, which is cosmetic: the
 *   client router owns the path either way.
 * - `.nojekyll` stops Pages from running the tree through Jekyll, which strips
 *   underscore-prefixed directories -- and SvelteKit puts every asset it builds
 *   in `_app/`. Without this the deploy is a blank page with 404s on every
 *   script, and the cause is invisible from the browser.
 *
 * Runs on every build rather than only in CI, so what is tested locally is what
 * deploys, and one build artifact is valid on any of these hosts.
 */

import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const build = 'build';
const shell = join(build, 'index.html');

copyFileSync(shell, join(build, '404.html'));
writeFileSync(join(build, '.nojekyll'), '');

console.log('spa-fallback: wrote 404.html and .nojekyll');
