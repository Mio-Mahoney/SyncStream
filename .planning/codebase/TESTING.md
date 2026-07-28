# Testing Patterns

**Analysis Date:** 2026-07-28

## Test Framework

**Runner:**
- Playwright Test 1.61.1 (`@playwright/test`)
- Config: `playwright.config.ts` at root
- Single browser: Chromium with full Chromium build (not headless shell) for WebCodecs and HEVC support

**Assertion Library:**
- Playwright's built-in expect: `expect(page).toHaveURL(pattern)`

**Run Commands:**
```bash
npm run test:e2e              # Run all e2e tests
npm run test:e2e -- --debug  # Debug a single test
```

## Test File Organization

**Location:**
- All e2e tests in `tests/e2e/` directory
- Test spec files: `*.spec.ts`
- Shared helpers: `tests/e2e/helpers.ts`
- Base constants: `tests/e2e/base.ts`
- Fixture data: `tests/fixtures/` directory

**Naming:**
- Spec files match feature: `join.spec.ts`, `mesh.spec.ts`, `pause.spec.ts`, `scale.spec.ts`
- Convention: one describe block per spec file, or no describe block for simple suites
- Test names are full sentences describing what happens: `'pasting the invite link the host copied joins that room'`

**Test Files:**
```
tests/
├── e2e/
│   ├── base.ts              # Shared constants: BASE path, LOCAL_RELAY_PORT/URL
│   ├── helpers.ts           # Utilities: snapshot(), until(), openRoom(), nameYourself()
│   ├── local-relay.ts       # WebSocket relay for localhost signaling (?s=local)
│   ├── join.spec.ts         # Landing page: code entry and link parsing
│   ├── mesh.spec.ts         # Mesh distribution under bandwidth constraints
│   ├── pause.spec.ts        # Pause/resume barrier behavior
│   ├── invite.spec.ts       # Guest joining flow
│   ├── room.spec.ts         # Room state and lifecycle
│   ├── naming.spec.ts       # Identity: naming guests and host
│   ├── waiting.spec.ts      # Readiness barrier ("Waiting for...")
│   ├── rendezvous.spec.ts   # Signaling strategy fallback (public relays)
│   ├── scale.spec.ts        # Multiple guests at various scales
│   ├── film.spec.ts         # Film metadata handling
│   ├── media.spec.ts        # Media probing and streaming
│   ├── picker.spec.ts       # File picker interface
│   ├── abr-recovery.spec.ts # Adaptive bitrate + recovery
│   ├── real-movie.spec.ts   # Real video file playback
│   └── static.spec.ts       # No server running (static deploy)
└── fixtures/
    ├── gen.sh               # Generate fixture files
    └── *.mp4                # Test video files
```

## Test Structure

**Suite Organization:**
- Playwright `test()` imported from `@playwright/test`
- Simple specs have no describe block
- Complex specs use `test.describe()` for grouping related tests

**Basic Pattern:**
```typescript
import { expect, test } from '@playwright/test';
import { appPath } from './base';

test('description of what should happen', async ({ page, baseURL }) => {
	// Arrange: set up state
	await page.goto(appPath('/'));
	
	// Act: perform action
	const input = page.getByLabel('Room code');
	await input.fill('ABC123');
	await page.getByRole('button', { name: 'Join' }).click();
	
	// Assert: verify outcome
	await expect(page).toHaveURL(new RegExp(`/room/ABC123$`));
});
```

**Fixtures and Setup:**
- Playwright provides `page`, `browser`, `browserName`, `baseURL` fixtures
- `BrowserContext` used to create multiple guest pages in same test
- No global setup/teardown; each test is independent

**Example with Multiple Pages (Host + Guest):**
```typescript
test('four guests on a 12 Mbps uplink', async ({ page, browser }) => {
	const { code } = await openHost(page, 'large-2gb.mp4');
	
	const contexts: BrowserContext[] = [];
	const guests: Page[] = [];
	
	for (let i = 0; i < 4; i++) {
		const ctx = await browser.newContext();
		contexts.push(ctx);
		const { page: guest } = await openGuest(ctx, code);
		guests.push(guest);
	}
	
	// Test interaction across pages
	// Clean up
	for (const ctx of contexts) {
		await ctx.close();
	}
});
```

## Test Structure and Patterns

**Instrumentation Oracle:**
PLAN.md §8 establishes the testing philosophy: `window.__syncstream` is the oracle. Tests assert against its live state, never against DOM timing or guesses.

**Snapshot Type (from `tests/e2e/helpers.ts`):**
```typescript
type Snapshot = {
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
	mesh: {
		cacheBytes: number;
		cacheKeys: number;
		fromPeers: number;
		fromHost: number;
		uploaded: number;
		uploadedTo: Record<string, number>;
		fallbacks: number;
	} | null;
};
```

**Read State from Instrumentation:**
```typescript
import { snapshot } from './helpers';

const state = await snapshot(page);
expect(state.ttff).not.toBeNull();  // Time-to-first-frame recorded
expect(state.rung).toBe(1);         // Playing at rung 1 (720p)
expect(state.drift).toBeLessThan(100);  // Sync drift under 100ms
```

## Mocking

**Framework:**
- No explicit mocking library needed
- Page evaluation used for in-page mocking where necessary

**Approach:**
- Network throttling via Playwright's CDP: `throttle(page, bitsPerSec)`
- Strategy disabling: `?s=local` pins to localhost relay; `rendezvous.spec.ts` tests public relays
- File drops simulated via `DataTransfer` API in page: `dropFile(page, file)`

**What to Mock:**
- Network conditions (bandwidth, latency) via `page.context().route()`
- User input via `page.getByTestId().fill()`, `.click()`, `.setInputFiles()`
- File uploads via `dropFile()` helper

**What NOT to Mock:**
- WebRTC peer connections (integration test layer requires real ICE/SCTP)
- Media playback (Shaka Player state is asserted directly)
- Relay signaling (localhost relay used; public relays tested in `rendezvous.spec.ts`)

## Fixtures and Factories

**Test Data:**
- Video files in `tests/fixtures/` (checked into repo)
- Generated via `bash tests/fixtures/gen.sh` (creates small test videos)
- Large file variant: `bash tests/fixtures/gen.sh --large` (generates 2GB+ file for throughput tests)

**Helper Functions (from `tests/e2e/helpers.ts`):**

**Opening Rooms:**
```typescript
// Host opens room without file selected
const { code, errors } = await openRoom(page, { strategy: 'local' });

// Host opens room with file
const { code } = await openHost(page, 'small.mp4', { strategy: 'local' });

// Guest joins existing room
const { page: guest, errors } = await openGuest(browser.newContext(), code);
```

**State Reading:**
```typescript
const state = await snapshot(page);  // Read instrumentation state
const time = await videoTime(page);   // Get video.currentTime
```

**Polling with Deadline:**
```typescript
// Core pattern: no sleeps, poll for condition
await until(
	() => snapshot(guest),
	(s) => s.ttff !== null,
	{ 
		timeout: 30_000, 
		interval: 100, 
		what: 'first frame to render' 
	}
);
```

**Network Throttling:**
```typescript
await throttle(page, 3_000_000);  // 3 Mbps
await throttle(page, null);       // Clear throttle
```

**Naming:**
```typescript
await nameYourself(page, 'host', 'Alice');  // Sets identity
await nameYourself(page, 'guest-1', 'Bob');
```

## Coverage

**Target:** Integration tests, not unit coverage

**Strategy:**
- Every phase acceptance criterion is a passing test
- Fixture matrix exercises diverse file types (moov-at-start, moov-at-end, AC-3 audio, etc.)
- Throttle scenarios test ABR and sync behavior
- Strategy fallback tested (all three relays, one disabled at a time)

**Current Test Areas:**
- Landing page and room entry (`join.spec.ts`)
- Room lifecycle and guest joining (`room.spec.ts`, `invite.spec.ts`)
- Naming and identity (`naming.spec.ts`)
- Media selection and file drops (`picker.spec.ts`)
- Playback and sync (`scale.spec.ts`, `media.spec.ts`)
- Pause/resume and readiness barrier (`pause.spec.ts`, `waiting.spec.ts`)
- Bandwidth-constrained mesh (`mesh.spec.ts` with 12 Mbps uplink)
- Adaptive bitrate recovery (`abr-recovery.spec.ts`)
- Multiple guests at scale (`scale.spec.ts`)
- Signaling fallback (`rendezvous.spec.ts` with public relays)
- Static deployment verification (`static.spec.ts`)

**NOT Covered (by design):**
- Unit tests (logic in small functions tested through e2e)
- Snapshot testing
- Component visual testing

## Test Configuration

**Playwright Config (`playwright.config.ts`):**

**Timeouts:**
- Global test timeout: 120,000ms (2 min) — WebRTC + real encoding is slow
- Expectation timeout: 20,000ms
- Action timeout: 15,000ms (locator calls have no default timeout)

**Parallelization:**
- `fullyParallel: false` — tests run sequentially
- `workers: 1` — single worker, required for WebRTC hardware encoder fairness

**Failure Handling:**
- `retries: 0` — tests do not retry (flaky test is worse than none)
- `forbidOnly` — `test.only()` blocks CI runs, allows local debugging
- `trace: 'retain-on-failure'` — Playwright traces saved on test failure
- `video: 'off'` — videos not recorded (can be enabled locally)

**Browsers:**
- Chromium only (full build, not headless shell) for WebCodecs/HEVC support
- Special launch args:
  - `--autoplay-policy=no-user-gesture-required` — guests play without click
  - `--disable-features=WebRtcHideLocalIpsWithMdns` — ICE candidates visible in headless

**Servers:**
Two servers started for each test run:
1. App server: `bun run build && bun run preview --port 4173`
2. Local relay: `bun tests/e2e/local-relay.ts --port 4174`

Both use `reuseExistingServer: !process.env.CI` (reuse locally, fresh in CI).

## Async Testing

**Pattern: No Sleeps, Deadline-Based Polling**

The core principle from PLAN.md §8: "A flaky sync test is worse than no sync test because it trains you to ignore it."

**Wrong Way (Flaky):**
```typescript
await page.goto(appPath(`/room/${code}`));
await new Promise(r => setTimeout(r, 2000));  // Hope 2s is enough
const state = await snapshot(page);
expect(state.playing).toBe(true);
```

This fails intermittently if the room takes 2.1s to initialize.

**Right Way (Reliable):**
```typescript
await page.goto(appPath(`/room/${code}`));
await until(
	() => snapshot(page),
	(s) => s.playing === true,
	{ timeout: 30_000, what: 'playback to start' }
);
// If we reach here, playback is definitely playing
```

The `until()` helper (from `tests/e2e/helpers.ts`):
- Polls every 100ms (configurable)
- Catches transient errors (e.g., app not mounted yet; snapshot throws initially)
- Retries until deadline
- Fails with detailed error showing last value and final error message

**Error Messages Include Context:**
```
timed out after 30000ms waiting for playback to start; 
last={"playing":false,"ttff":null,...}
```

## Error Testing

**Pattern: Assert Error Messages**

```typescript
test('a link with no room code says so', async ({ page }) => {
	await page.goto(appPath('/'));
	const input = page.getByLabel('Room code');
	
	await input.fill('https://example.com/watch/tonight');
	
	// Input is cleared (code extraction failed)
	await expect(input).toHaveValue('');
	
	// Error message is visible
	await expect(page.getByTestId('join-error')).toBeVisible();
	
	// Join button disabled
	await expect(page.getByRole('button', { name: 'Join' })).toBeDisabled();
});
```

**Console Error Tracking:**
```typescript
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
// ... perform test ...
expect(errors).toHaveLength(0);  // No console errors
```

## Common Test Patterns

**Pattern: Room Setup → Assertion**
```typescript
import { openHost, openGuest, snapshot, until } from './helpers';

test('guest sees when host pauses', async ({ page, browser }) => {
	const { code } = await openHost(page, 'small.mp4');
	const ctx = await browser.newContext();
	const { page: guest } = await openGuest(ctx, code);
	
	// Wait for playback to start on both
	await until(
		() => snapshot(page),
		(s) => s.playing,
		{ what: 'host playback' }
	);
	await until(
		() => snapshot(guest),
		(s) => s.playing,
		{ what: 'guest playback' }
	);
	
	// Host pauses
	await page.getByRole('button', { name: 'Pause' }).click();
	
	// Guest sees pause within deadline
	await until(
		() => snapshot(guest),
		(s) => !s.playing,
		{ what: 'guest to see pause' }
	);
	
	await ctx.close();
});
```

**Pattern: Throttle and Observe Adaptation**
```typescript
test('guest throttled to 1.5 Mbps plays at 480p', async ({ page, browser }) => {
	const { code } = await openHost(page, 'large-2gb.mp4');
	const ctx = await browser.newContext();
	const { page: guest } = await openGuest(ctx, code);
	
	// Throttle after join, before playback
	await throttle(guest, 1_500_000);  // 1.5 Mbps
	
	await until(
		() => snapshot(guest),
		(s) => s.rung === 2 && s.ttff !== null,
		{ what: 'guest to stabilize at 480p (rung 2)' }
	);
	
	// Verify no stalls during playback
	const initial = await snapshot(guest);
	await new Promise(r => setTimeout(r, 5000));
	const later = await snapshot(guest);
	expect(later.bufferedAhead).toBeGreaterThan(initial.bufferedAhead);
	
	await ctx.close();
});
```

**Pattern: Network Strategy Fallback**
```typescript
test('guest succeeds when primary relay disabled', async ({ page, browser }) => {
	// Host uses `?s=local` (localhost relay)
	const { code } = await openHost(page, 'small.mp4', { strategy: 'local' });
	
	// Guest joins on same strategy
	const ctx = await browser.newContext();
	const { page: guest } = await openGuest(ctx, code, { strategy: 'local' });
	
	await until(
		() => snapshot(guest),
		(s) => s.playing,
		{ timeout: 45_000, what: 'guest to join and play' }
	);
	
	await ctx.close();
});
```

## Test Configuration Reference

**Key Environment Variables:**
- `BASE_PATH` — app base path (default `/SyncStream` to match Pages deploy)
- `VITE_LOCAL_RELAY` — URL of localhost relay (`ws://localhost:4174`)
- `CI` — set by GitHub Actions; disables server reuse

**Skipping Tests:**
```typescript
test.skip(
	!existsSync(large),
	'needs tests/fixtures/large-2gb.mp4 (bash tests/fixtures/gen.sh --large)'
);
```

---

*Testing analysis: 2026-07-28*
