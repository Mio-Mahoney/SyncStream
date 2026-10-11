import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],

	// Vite only inlines import.meta.env keys matching envPrefix, and SvelteKit
	// deliberately does not widen it. Without PUBLIC_ here the PUBLIC_TURN_*
	// variables in $lib/rtc/ice are always undefined, and TURN stays
	// unconfigured forever -- including on the day someone finally supplies a
	// server (PLAN.md 9).
	envPrefix: ['VITE_', 'PUBLIC_'],

	// `vite preview` is the e2e suite's server, and insecure-origin.spec.ts
	// reaches it under a name that is not localhost on purpose: that is the
	// only way to get a page that is not a secure context out of a loopback
	// server. The name resolves nowhere outside that spec's own browser.
	preview: { allowedHosts: ['insecure.test'] },

	worker: {
		// The transcode worker imports mp4box and mp4-muxer as ES modules; the
		// classic worker format cannot express those imports (PLAN.md 4.5).
		format: 'es'
	}
});
