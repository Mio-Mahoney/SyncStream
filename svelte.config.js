import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

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
			fallback: 'index.html',
			precompress: false,
			strict: false
		})
	}
};

export default config;
