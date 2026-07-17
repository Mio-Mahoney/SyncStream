import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],

	// Vite only inlines import.meta.env keys matching envPrefix, and SvelteKit
	// deliberately does not widen it. Without PUBLIC_ here,
	// import.meta.env.PUBLIC_SUPABASE_URL is always undefined and the Supabase
	// rendezvous strategy in $lib/rendezvous/trystero reports
	// isConfigured() === false forever -- including on the day someone finally
	// supplies credentials (PLAN.md 4.6).
	envPrefix: ['VITE_', 'PUBLIC_'],

	worker: {
		// The transcode worker imports mp4box and mp4-muxer as ES modules; the
		// classic worker format cannot express those imports (PLAN.md 4.5).
		format: 'es'
	}
});
