import { defineConfig, devices } from '@playwright/test';
import { BASE } from './tests/e2e/base';

/**
 * PLAN.md 8.
 *
 * The instrumentation from Phase 0 is the oracle: tests assert against
 * `window.__syncstream`, never against timing guesses. No sleeps -- poll for
 * conditions with explicit deadlines. A flaky sync test is worse than no sync
 * test because it trains you to ignore it.
 *
 * `channel: 'chromium'` rather than the default headless shell is load-bearing.
 * Measured on this machine (Chromium 149):
 *
 *   headless shell : WebCodecs yes, H.264 encode yes, HEVC decode NO
 *   channel chromium: WebCodecs yes, H.264 encode yes, HEVC decode YES
 *
 * The Phase 4 tier-2 test needs HEVC decode, so we take the full build.
 * Note also that WebCodecs requires a secure context, so tests must run against
 * http://localhost (which qualifies) and never about:blank.
 */
export default defineConfig({
	testDir: './tests/e2e',
	// WebRTC + real encoding is slow; these are integration tests, not unit tests.
	timeout: 120_000,
	expect: { timeout: 20_000 },
	fullyParallel: false,
	// Media pipelines contend for the hardware encoder; parallel workers make
	// throughput assertions meaningless.
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: 0,
	reporter: process.env.CI ? [['github'], ['list']] : [['list']],

	use: {
		// Origin only. The base path is NOT folded in here: Playwright resolves a
		// goto() against this with `new URL()`, and a leading-slash path replaces
		// the whole path rather than appending to it, silently dropping the prefix.
		// Tests build paths with `appPath()` instead, which is explicit.
		baseURL: 'http://localhost:4173',
		trace: 'retain-on-failure',
		video: 'off',
		// Locator calls like textContent() default to NO timeout, so a query for
		// an element that is legitimately absent waits forever and even a
		// .catch() never fires. Bound them, so a missing element fails the test
		// it belongs to instead of eating the whole run's budget.
		actionTimeout: 15_000
	},

	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				channel: 'chromium',
				launchOptions: {
					args: [
						// Guests must start playing without a click.
						'--autoplay-policy=no-user-gesture-required',
						// Chrome hides host ICE candidates behind mDNS .local names,
						// which do not resolve in a headless environment, so ICE never
						// completes and every data channel hangs forever. Measured:
						// without this, the channel never opens; with it, it opens in
						// well under a second. Real users are unaffected -- mDNS works
						// on a real LAN -- so this is a test-environment fix, not a
						// product change.
						'--disable-features=WebRtcHideLocalIpsWithMdns'
					]
				}
			}
		}
	],

	/**
	 * PLAN.md 4.7 / Phase 1 acceptance: the whole app is served by a dumb static
	 * file server with no backend process running. `vite preview` only serves
	 * files out of build/; `tests/e2e/static.spec.ts` asserts the build contains
	 * no server entry point at all.
	 */
	webServer: {
		command: 'bun run build && bun run preview --port 4173 --strictPort',
		port: 4173,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
		// The build and the tests must agree on the base path, or the suite
		// navigates to paths the server does not serve.
		env: { BASE_PATH: BASE }
	}
});
