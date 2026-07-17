import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Where the app is served from, without a trailing slash. Empty means a root
 * domain, which is what `bun run dev` wants.
 *
 * A GitHub Pages *project* site is served under /<repo>/, so the deploy
 * workflow sets this to /SyncStream. It is an env var rather than a constant
 * because the same build has to work at a root domain too -- a custom domain,
 * or Cloudflare Pages -- and the difference is a deploy detail, not a code one.
 *
 * Anything constructing a URL must route it through `$app/paths`, or it will
 * silently produce a link that 404s under a non-empty base. `room/host.ts`'s
 * share link is the one that matters: it is the entire point of the product.
 */
const base = process.env.BASE_PATH ?? '';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		// PLAN.md 4.7: there is no server, so the whole app is static files.
		// `fallback` gives SPA routing for /room/[id], whose ids only ever exist
		// client-side and so can never be enumerated at build time.
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			// Nothing prerenders (ssr = false, prerender = false in +layout.ts), so
			// this fallback IS the only HTML the build emits -- it is the shell every
			// route boots from, not a rarely-hit error page. It must therefore stay
			// index.html, or the landing page itself would have no file to serve.
			//
			// GitHub Pages needs the same shell duplicated at 404.html, since it has
			// no rewrite rules and serving 404.html for an unmatched path is the only
			// SPA fallback it offers. `bun run build` writes that copy (see
			// package.json), which is also why static/_redirects can stay: hosts that
			// honour it (Cloudflare Pages, Netlify) rewrite /room/<code> to the shell
			// before a 404 is ever reached, and the extra file costs them nothing.
			fallback: 'index.html',
			precompress: false,
			strict: false
		}),
		paths: { base }
	}
};

export default config;
