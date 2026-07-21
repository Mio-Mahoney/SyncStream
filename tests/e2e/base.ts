/**
 * The base path the suite runs the app under.
 *
 * Defaulted to a non-empty prefix on purpose, matching what the Pages deploy
 * builds (see .github/workflows/deploy.yml). A root-domain test run would pass
 * while the deployed invite link 404s, because `base` is only ever wrong when it
 * is not empty -- so testing at the root tests the one configuration that cannot
 * catch the bug. Set BASE_PATH='' to run against a root domain instead.
 *
 * Imported by playwright.config.ts as well, which is what keeps the value the
 * build uses and the value the tests navigate to from drifting apart.
 */
export const BASE = process.env.BASE_PATH ?? '/SyncStream';

/** An app-relative path, prefixed with the base the app is served under. */
export const appPath = (path: string): string => `${BASE}${path}`;

/**
 * The localhost signaling relay (tests/e2e/local-relay.ts) that `?s=local`
 * rooms rendezvous over. One constant, three readers: the relay binds it, the
 * config bakes the URL into the app build as VITE_LOCAL_RELAY, and Playwright
 * waits on the port -- so none of them can drift apart.
 */
export const LOCAL_RELAY_PORT = 4174;
export const LOCAL_RELAY_URL = `ws://localhost:${LOCAL_RELAY_PORT}`;
