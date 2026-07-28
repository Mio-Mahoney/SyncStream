# Technology Stack

**Analysis Date:** 2026-07-28

## Languages

**Primary:**
- TypeScript 5.0 - All source code in `src/`
- JavaScript (ES modules) - Build scripts, configuration

**Secondary:**
- Bash - Test fixture generation (`tests/fixtures/gen.sh`)

## Runtime

**Environment:**
- Node.js or Bun (no explicit version specified in `.nvmrc` or `package.json`)
- ES modules (`"type": "module"` in `package.json`)

**Package Manager:**
- npm/pnpm (supports either; lockfile type not specified)
- Lockfile: Not detected in repo

## Frameworks

**Core:**
- SvelteKit 2.69.3 - Full-stack framework, using static adapter for SPA
- Svelte 5.56.6 - Component framework with runes support
- Vite 8.1.5 - Build tool and dev server

**Testing:**
- Playwright 1.61.1 - E2E tests (`tests/e2e/`)
  - Config: `playwright.config.ts`
  - Uses Chromium channel for WebCodecs support
  - Runs against localhost:4173 (Vite preview)

**Build/Dev:**
- @sveltejs/adapter-static 3.0.10 - Static file output (no server)
- @sveltejs/vite-plugin-svelte 7.2.0 - Svelte compilation in Vite
- vite-plugin-svelte (via Vite) - Svelte component bundling

**Styling & CSS:**
- Tailwind CSS 3.4.13 - Utility-first CSS framework
- PostCSS 8.4.47 - CSS processing
- Autoprefixer 10.4.20 - Browser vendor prefix injection

**Code Quality:**
- ESLint 9.0.0 - Linting
  - Config: `eslint.config.js` (flat config format)
  - Plugins: typescript-eslint, eslint-plugin-svelte
- Prettier 3.1.1 - Code formatting
  - Config: `.prettierrc`
  - Plugin: prettier-plugin-svelte
- svelte-check 4.0.0 - Svelte type checking

## Key Dependencies

**Critical:**
- trystero 0.25.3 - P2P rendezvous signaling (Nostr relay backend)
- @trystero-p2p/mqtt 0.25.3 - P2P rendezvous via MQTT brokers
- shaka-player 5.2.1 - DASH/CMAF video playback and adaptive bitrate streaming
  - Used for MSE buffer management, ABR controller, browser quirk handling
  - File: `src/lib/media/shaka/config.ts`

**Media Processing:**
- mp4box 2.4.1 - MP4 parsing, demuxing, CMAF segmentation
- mp4-muxer 5.2.2 - MP4 muxing for re-encoding transcoder output
- WebCodecs API - In-browser video/audio encoding and decoding (native browser API)

**Utilities:**
- globals 15.0.0 - Global variable types for ESLint

## Configuration

**Environment:**
- Vite config: `vite.config.ts`
  - `envPrefix: ['VITE_', 'PUBLIC_']` - Keys exposed to client code
  - Worker format: `'es'` - For transcode worker importing mp4box
- SvelteKit config: `svelte.config.js`
  - Adapter: `adapter-static` with SPA fallback
  - Base path: `process.env.BASE_PATH` (for GitHub Pages deployments)
  - No SSR, no prerendering

**Build:**
- TypeScript config: `tsconfig.json`
  - Extends `.svelte-kit/tsconfig.json`
  - Strict mode enabled
  - Source maps enabled
  - Module resolution: bundler
- Prettier config: `.prettierrc`
  - Tabs (4 spaces per tab)
  - Single quotes
  - Print width: 100
  - Svelte plugin enabled
- ESLint config: `eslint.config.js`
  - Flat config format (v9+)
  - Covers TypeScript, Svelte, and browser globals
- Tailwind config: `tailwind.config.js`
  - Custom color palette (moonstone, vanilla, tangerine)
  - Roboto font family
  - No plugins
- PostCSS config: `postcss.config.js`
  - Tailwind CSS plugin
  - Autoprefixer plugin

## Platform Requirements

**Development:**
- Browser with WebCodecs support (Chromium for testing HEVC decode)
- WebRTC support (for peer connections)
- Media Source Extensions (MSE) support
- For hosting: local filesystem access (File API, File.slice())

**Production:**
- Static hosting only: GitHub Pages, Cloudflare Pages, or any static file server
- No server process, no database, no infrastructure
- Zero fixed hosting cost
- Client browsers must support:
  - WebRTC (RTCPeerConnection, data channels)
  - Media Source Extensions (MSE)
  - WebCodecs (video/audio encoding/decoding)
  - WebCrypto (crypto.getRandomValues for room code generation)
  - localStorage (optional - for user name persistence)

---

*Stack analysis: 2026-07-28*
