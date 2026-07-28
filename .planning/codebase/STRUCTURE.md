# Codebase Structure

**Analysis Date:** 2026-07-28

## Directory Layout

```
SyncStream/
├── src/
│   ├── routes/
│   │   ├── +layout.svelte           # Global shell, imports app.css
│   │   ├── +page.svelte             # Landing page (create/join room)
│   │   └── room/
│   │       └── [id]/
│   │           └── +page.svelte     # Room page (watch party)
│   ├── lib/
│   │   ├── rendezvous/              # Peer discovery via relays
│   │   │   ├── room.ts              # Room-level policy, strategy ladder
│   │   │   ├── transport.ts         # Abstract session interface
│   │   │   ├── trystero.ts          # Trystero (@mqtt, @nostr) adapter
│   │   │   ├── local.ts             # Localhost relay (e2e hermetic)
│   │   │   └── codes.ts             # Room code generation/validation
│   │   ├── rtc/                     # WebRTC connections
│   │   │   ├── connection.ts        # Peer discovery, network mgmt
│   │   │   ├── channel.ts           # Data channel framing, backpressure
│   │   │   └── ice.ts               # ICE candidate type inspection
│   │   ├── protocol/                # Control message types
│   │   │   ├── control.ts           # Hello, Ready, State, Intent, Roster, etc.
│   │   │   └── wire.ts              # Serialization (rarely used)
│   │   ├── room/                    # Host/guest orchestration
│   │   │   ├── host.ts              # HostRoom, file handling, authority
│   │   │   └── guest.ts             # GuestRoom, Shaka integration
│   │   ├── sync/                    # Playback sync engine
│   │   │   ├── state.ts             # HostState, GuestSync, barrier
│   │   │   └── clock.ts             # NTP-style clock sync
│   │   ├── media/                   # Media processing
│   │   │   ├── probe.ts             # Codec probe, tier detection
│   │   │   ├── source.ts            # Byte range reader, rep 0 CMAF
│   │   │   ├── origin.ts            # Compose probe+source+ladder+manifest
│   │   │   ├── ladder.ts            # ABR encoder pool
│   │   │   ├── manifest.ts          # DASH MPD builder
│   │   │   ├── types.ts             # Shared media types
│   │   │   ├── shaka/
│   │   │   │   ├── config.ts        # Shaka Player config, ABR
│   │   │   │   └── scheme.ts        # Custom URI scheme handler
│   │   │   └── worker/
│   │   │       └── encode.worker.ts # WebCodecs encode worker
│   │   ├── mesh/                    # Phase 5 peer distribution
│   │   │   └── mesh.ts              # Segment router, peer selection
│   │   ├── *.svelte                 # UI Components
│   │   │   ├── HostBar.svelte       # Host presence bar
│   │   │   ├── FilePicker.svelte    # File selection with drag-drop
│   │   │   ├── PlayerControls.svelte# Play/pause/seek controls
│   │   │   ├── Presence.svelte      # Guest roster display
│   │   │   ├── WaitingRoom.svelte   # Loading/waiting states
│   │   │   ├── InvitePanel.svelte   # Share link copy UI
│   │   │   ├── DebugOverlay.svelte  # Stats/metrics (debug only)
│   │   │   └── [others]
│   │   ├── identity.ts              # Persistent name storage
│   │   ├── names.ts                 # Fallback name generation
│   │   ├── film.ts                  # Film metadata (title, duration)
│   │   ├── invite.ts                # Invite link formatting
│   │   ├── barrier.ts               # Readiness barrier utilities
│   │   └── stats.svelte.ts          # Global instrumentation (debug)
│   ├── app.d.ts                     # TypeScript app types
│   └── app.css                      # Global styles (Tailwind)
├── tests/
│   ├── e2e/
│   │   ├── *.spec.ts                # Playwright e2e tests
│   │   ├── helpers.ts               # Test utilities (openHost, until, etc.)
│   │   ├── base.ts                  # Test config (BASE URL, appPath)
│   │   └── local-relay.ts           # Localhost signaling server
│   └── fixtures/
│       ├── tiny-60s.mp4             # Committed test video
│       ├── gen.sh                   # Generate test fixtures
│       └── [other fixtures]
├── scripts/
│   └── spa-fallback.js              # Post-build: copy index.html → 404.html
├── static/
│   ├── _redirects                   # Netlify/Cloudflare rewrite rules
│   └── .nojekyll                    # GitHub Pages: disable Jekyll
├── .github/
│   └── workflows/
│       └── deploy.yml               # Build & publish to GitHub Pages
├── .claude/
│   └── [agent workspace files]
├── build/                           # Output of `bun run build`
├── .svelte-kit/                     # SvelteKit generated files
├── node_modules/                    # Installed dependencies
├── package.json                     # Dependencies: @trystero, shaka-player, etc.
├── bun.lock                         # Bun lockfile
├── svelte.config.js                 # SvelteKit adapter config
├── vite.config.ts                   # Vite build config (implicit)
├── tsconfig.json                    # TypeScript config
├── playwright.config.ts             # Playwright e2e config
├── eslint.config.js                 # ESLint rules
├── .prettierrc                      # Prettier formatting
├── tailwind.config.js               # Tailwind CSS config
├── postcss.config.js                # PostCSS (Tailwind processor)
├── PLAN.md                          # Architecture & design decisions
└── README.md                        # User-facing docs
```

## Directory Purposes

**`src/routes/`**
- Purpose: SvelteKit file-based routing
- Contains: Page components (`+page.svelte`), layouts (`+layout.svelte`)
- Key files: `+page.svelte` (landing), `room/[id]/+page.svelte` (watch party)

**`src/lib/rendezvous/`**
- Purpose: Peer discovery via public relays (Nostr, MQTT, Supabase)
- Contains: Strategy adapters, room-level policy, code handling
- Exports: Functions and types for joining/hosting rooms
- Key pattern: Strategy ladder with fallback (PLAN.md 4.6)

**`src/lib/rtc/`**
- Purpose: WebRTC setup and management
- Contains: Peer connection lifecycle, data channel attachment, ICE inspection
- Exports: PeerNetwork (peer discovery API), PeerLink (per-peer connection)
- Key pattern: Event-driven peer subscription

**`src/lib/protocol/`**
- Purpose: Control message schema and types
- Contains: Message type definitions (Hello, Ready, State, Intent, Roster, etc.)
- Exports: TypeScript types and constants (INIT_SEGMENT sentinel, etc.)
- Key invariant: Host authority only; guests send intent, never state

**`src/lib/room/`**
- Purpose: Orchestrate host or guest role
- Contains: HostRoom and GuestRoom factory functions + implementations
- Exports: Room API (setFile, setName, intent, close)
- Key pattern: Async factory returning state machine + callbacks

**`src/lib/sync/`**
- Purpose: Synchronize playback state and wall-clock time
- Contains: Clock sync via NTP, host/guest playback state machines, readiness barrier
- Exports: HostState (authority), GuestSync (follower), ClockSync
- Key invariant: Host broadcasts state; guests never send state to each other

**`src/lib/media/`**
- Purpose: Probe, segment, and encode local files
- Contains: Codec probe, CMAF segmenter, ABR ladder, DASH manifest builder, Shaka integration
- Exports: Origin (probe + source + ladder + manifest), Ladder, Manifest
- Key flow: probe → source → ladder → manifest
- Tier system: 1 (native), 2 (transcode), 3 (reject)

**`src/lib/media/worker/`**
- Purpose: Offload CPU-intensive encoding
- Contains: WebCodecs encode worker
- Runs in: Dedicated worker thread
- Communicates via: PostMessage (encode requests/responses)

**`src/lib/mesh/`**
- Purpose: Peer-to-peer segment distribution (Phase 5 optimization)
- Contains: Segment cache, peer throughput tracking, fetch routing
- Exports: Mesh (segment fetcher wrapping another fetcher)
- Key invariant: Host always available as fallback

**`src/lib/*.svelte`**
- Purpose: UI components
- Contains: Reusable Svelte components for video player, invite panel, presence, etc.
- Pattern: Runes-based ($state, $props, $derived) for reactive state
- Files:
  - `FilePicker.svelte`: File selection with drag-drop (host only)
  - `PlayerControls.svelte`: Play/pause/seek bar
  - `Presence.svelte`: Guest roster (guest view)
  - `HostBar.svelte`: Host presence indicator
  - `WaitingRoom.svelte`: Loading/state screens
  - `InvitePanel.svelte`: Share link display
  - `DebugOverlay.svelte`: Stats for `?debug` mode

**`src/lib/*.ts` (utilities)**
- `identity.ts`: Persistent name storage (localStorage)
- `names.ts`: Generate fallback names ("Guest 412")
- `film.ts`: Extract film title from File
- `invite.ts`: Format invite links
- `barrier.ts`: Utility types for readiness barrier
- `stats.svelte.ts`: Global stats object for instrumentation

**`tests/e2e/`**
- Purpose: End-to-end tests with Playwright
- Contains: Test specs, helpers, base config
- Runs: Two real browser contexts (host + guest)
- Key files:
  - `*.spec.ts`: Test cases (room.spec.ts, mesh.spec.ts, etc.)
  - `helpers.ts`: Test utilities (openHost, openGuest, until, snapshot)
  - `base.ts`: Config (BASE URL, appPath)
  - `local-relay.ts`: Localhost signaling for hermetic tests

**`tests/fixtures/`**
- Purpose: Test video files
- Contains: `tiny-60s.mp4` (committed), large fixtures (gitignored, opt-in)
- Generated by: `tests/fixtures/gen.sh`

**`scripts/`**
- Purpose: Build-time helpers
- Contains: `spa-fallback.js` (copy index.html to 404.html for GitHub Pages)

**`static/`**
- Purpose: Static assets served at root
- Contains: `_redirects` (Netlify/Cloudflare routing), `.nojekyll` (GitHub Pages config)

**`.github/workflows/`**
- Purpose: CI/CD automation
- Contains: `deploy.yml` (build on push to main, publish to GitHub Pages)

**Configuration files**
- `package.json`: Runtime deps (trystero, shaka-player, mp4box, mp4-muxer)
- `tsconfig.json`: TypeScript config (includes Svelte, strict mode)
- `svelte.config.js`: SvelteKit adapter (static), BASE_PATH support
- `tailwind.config.js`: CSS utility framework
- `postcss.config.js`: CSS processing (Tailwind)
- `playwright.config.ts`: Browser automation config (e2e)
- `eslint.config.js`: Linting rules
- `.prettierrc`: Code formatting
- `vite.config.ts`: (Implicit) Vite bundler config (via SvelteKit)

## Key File Locations

**Entry Points:**
- `src/routes/+page.svelte`: Landing page (create/join UI)
- `src/routes/room/[id]/+page.svelte`: Watch party (main UX)
- `src/routes/+layout.svelte`: Global shell

**Configuration:**
- `package.json`: Dependencies and scripts
- `svelte.config.js`: SvelteKit + adapter config
- `tailwind.config.js`: Design tokens (colors, spacing)
- `playwright.config.ts`: E2E test framework
- `.prettierrc`: Code style

**Core Logic:**
- `src/lib/room/host.ts`: Host orchestration
- `src/lib/room/guest.ts`: Guest orchestration
- `src/lib/rendezvous/room.ts`: Peer discovery policy
- `src/lib/sync/state.ts`: Playback sync engine
- `src/lib/media/origin.ts`: Media assembly

**Testing:**
- `tests/e2e/*.spec.ts`: Test cases
- `tests/e2e/helpers.ts`: Test utilities
- `tests/e2e/base.ts`: Test config
- `tests/fixtures/gen.sh`: Generate test videos

## Naming Conventions

**Files:**
- Routes: `+page.svelte`, `+layout.svelte` (SvelteKit reserved)
- Components: PascalCase (e.g., `FilePicker.svelte`)
- Libraries: camelCase (e.g., `origin.ts`, `host.ts`)
- Workers: `.worker.ts` suffix (e.g., `encode.worker.ts`)
- Tests: `.spec.ts` suffix (Playwright convention)

**Directories:**
- Top-level: lowercase (src, tests, scripts, static)
- Modules: lowercase (rendezvous, rtc, media, sync, mesh, room)
- Exports: Folders contain single module (no subfolders except shaka, worker)

**Functions & Types:**
- Factory functions: `create*`, `start*` (e.g., createOrigin, startHostRoom)
- Event handlers: `on*` (e.g., onPeer, onControl)
- Predicates: `is*` (e.g., isValidRoomCode)
- Types: PascalCase (e.g., HostRoom, RendezvousSession)
- Constants: UPPER_SNAKE_CASE (e.g., HEARTBEAT_MS, DEADBAND_SEC)

**Component props & state:**
- Props via `let { prop1, prop2 } = $props()`
- State via `let state = $state(initialValue)`
- Derived via `const derived = $derived(expression)`

## Where to Add New Code

**New Feature (e.g., Add pause reason UI):**
- Primary code: `src/lib/room/host.ts` (add field to HostRoom), `src/lib/sync/state.ts` (track reason)
- UI component: `src/lib/*.svelte` (new component or update existing)
- Tests: `tests/e2e/pause.spec.ts` (update existing test)
- Example: `onPaused` callback already passes reason; just render it

**New Component/Module (e.g., Add recording):**
- Implementation: `src/lib/recording/` (new folder)
- Export interface from `src/lib/recording/recording.ts` (factory function)
- Integrate into room: `src/lib/room/host.ts` (call recording.start() on file select)
- UI: `src/lib/RecordingIndicator.svelte` (new component in src/lib/)
- Tests: `tests/e2e/recording.spec.ts` (new file)

**Utilities/Helpers:**
- Shared helpers: `src/lib/*.ts` (e.g., identity.ts, film.ts)
- Module-specific: Inside module folder (e.g., `src/lib/media/probe.ts`)
- Reusable SVG/icons: `static/` or inline in component

**Tests:**
- E2E test: `tests/e2e/[feature].spec.ts`
- Use `openHost()`, `openGuest()`, `until()` from helpers.ts
- Use `?debug` query param to inspect stats: `{ ttff, iceState, drift, rung, ... }`

**Styling:**
- Utility classes: Use Tailwind (configured in tailwind.config.js)
- Component styles: Scoped `<style>` blocks (compiled to CSS modules)
- Global: `src/app.css` (imported in +layout.svelte)
- Colors: Custom palette in tailwind.config.js (moonstone-*, tangerine-*, slate-*)

## Special Directories

**`.svelte-kit/`**
- Purpose: SvelteKit generated files
- Generated: Yes, on `bun run dev` or `npm install`
- Committed: No (in .gitignore)
- Contains: Type definitions, manifest, routes index

**`build/`**
- Purpose: Production bundle output
- Generated: Yes, from `bun run build`
- Committed: No (in .gitignore)
- Contents: Static HTML, JS, CSS, 404.html fallback

**`node_modules/`**
- Purpose: NPM package dependencies
- Generated: Yes, by `bun install`
- Committed: No (in .gitignore)

**`test-results/`**
- Purpose: Playwright test reports
- Generated: Yes, from `bun run test:e2e`
- Committed: No (in .gitignore)

**`.claude/`**
- Purpose: Claude Code agent state (workspace branches, memory, etc.)
- Generated: Yes, by agent operations
- Committed: No (in .gitignore)

## Module Dependency Graph

```
Routes (src/routes/)
  └── Room (host.ts, guest.ts)
        ├── Rendezvous (room.ts)
        │   └── Transport (transport.ts)
        │       └── Trystero / Local (trystero.ts, local.ts)
        ├── RTC (connection.ts)
        │   └── Channel (channel.ts)
        │       └── Protocol (control.ts)
        ├── Sync (state.ts, clock.ts)
        │   └── Protocol (control.ts)
        ├── Media (origin.ts)
        │   ├── Probe (probe.ts)
        │   ├── Source (source.ts)
        │   ├── Ladder (ladder.ts)
        │   │   └── Worker (encode.worker.ts)
        │   └── Manifest (manifest.ts)
        └── Mesh (mesh.ts)
            ├── Protocol (control.ts)
            └── RTC (connection.ts)
```

---

*Structure analysis: 2026-07-28*
