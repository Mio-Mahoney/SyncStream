# External Integrations

**Analysis Date:** 2026-07-28

## APIs & External Services

**P2P Signaling (Rendezvous):**
- Nostr Relays - P2P signaling backend for WebRTC rendezvous
  - SDK/Client: `trystero` (root export)
  - Implementation: `src/lib/rendezvous/trystero.ts` (line 198-218)
  - Public relays, no authentication required
  - Always available as fallback in strategy ladder
  - Free, unlimited quota

- MQTT Brokers - Alternative P2P signaling backend
  - SDK/Client: `@trystero-p2p/mqtt` 0.25.3
  - Implementation: `src/lib/rendezvous/trystero.ts` (line 221-238)
  - Public brokers, no authentication required
  - Free, unlimited quota

- Local Relay (Testing/Development) - Localhost signaling for hermetic e2e tests
  - Env var: `VITE_LOCAL_RELAY`
  - Implementation: `src/lib/rendezvous/local.ts`
  - Only present when `VITE_LOCAL_RELAY` is set at build time
  - Test server: `tests/e2e/local-relay.ts` runs on configurable port

**Strategy Ladder (Priority Order):**
1. Nostr relays (try first, always available)
2. MQTT brokers (fallback if Nostr fails)
3. Local relay (test/dev only, exclusive if explicitly requested via `?s=local`)

Implementation: `src/lib/rendezvous/transport.ts` and `src/lib/rendezvous/trystero.ts`

## Network & Connectivity

**STUN Servers:**
- Google: `stun:stun.l.google.com:19302`, `stun:stun1.l.google.com:19302`
- Cloudflare: `stun:stun.cloudflare.com:3478`
- Purpose: NAT traversal for WebRTC ICE candidate gathering
- Configuration: `src/lib/rtc/ice.ts` (line 16-20)
- Always enabled, no config needed

**TURN Servers (Optional):**
- Connection: Optional, configured via environment variables at build time
- Env vars: `PUBLIC_TURN_URLS`, `PUBLIC_TURN_USERNAME`, `PUBLIC_TURN_CREDENTIAL`
- Default: Not configured (null), STUN-only is the baseline
- Use case: Symmetric NAT / CGNAT fallback (only when measurements show it's needed)
- Implementation: `src/lib/rtc/ice.ts` (lines 42-52, 66-76)
- Cost: Usage-based (every byte relayed), only enabled if decision data warrants it
- Security: Credentials are public in static build, must use quota'd/ephemeral service

## Data Storage

**Client-Side Only:**
- localStorage - User display name persistence
  - Key: `syncstream:name`
  - Scope: Single name per browser (persists across rooms)
  - Usage: `src/lib/identity.ts` (read/write functions)
  - Fallback: If localStorage unavailable (privacy mode), app uses generated "Guest" names
  - No personal data beyond a chosen display name

**In-Memory Caches:**
- Segment cache in Mesh network layer
  - Purpose: Cache received video segments for serving to peer guests
  - Size: Configurable (default `MESH_CACHE_BYTES`)
  - Implementation: `src/lib/mesh/mesh.ts`

**No Database:**
- No persistent backend storage
- No room state server
- Rooms exist only in peer memory during active session
- Room codes generated client-side with crypto.getRandomValues() (34^6 ≈ 1.5B codes)

## Video & Media

**Playback:**
- Shaka Player 5.2.1 - DASH/CMAF video playback
  - Handles Media Source Extensions (MSE) buffer management
  - Implements adaptive bitrate (ABR) selection
  - Configuration: `src/lib/media/shaka/config.ts`
  - Custom URI scheme: `syncstream://rep/{repId}/video/seg/{segIdx}`
  - Registers scheme handler: `src/lib/media/shaka/scheme.ts`

**Encoding/Decoding:**
- WebCodecs API (native browser) - In-browser video and audio transcoding
  - Video: H.264 (avc1) encoding to multiple quality rungs
  - Audio: AAC encoding (fallback for non-native codecs like AC-3, DTS)
  - Worker: `src/lib/media/worker/encode.worker.ts`
  - Configuration: Vite worker format set to 'es' for ES module imports

**Media Processing:**
- mp4box 2.4.1 - MP4 parsing and demuxing
  - Purpose: Probe file format, extract metadata, segment MP4 into CMAF chunks
  - Implementation: `src/lib/media/` directory (probe, source, manifest, ladder)

- mp4-muxer 5.2.2 - MP4 muxing
  - Purpose: Package WebCodecs-encoded video/audio into fMP4 format
  - Implementation: Transcode worker output

## Authentication & Identity

**None Required:**
- No user accounts
- No login/registration
- No API keys in source code
- Trystero backends (Nostr, MQTT) are public and quota-less
- Optional TURN credentials (if configured) are public by design

**Room Access Control:**
- Room codes are 6-character alphanumeric, generated client-side
- No server-side verification (collision detected at join time)
- Link sharing model: whoever has the code can join
- No role-based access control (host = origin provider, guest = consumer)

## Monitoring & Observability

**Error Tracking:**
- None configured
- Errors logged to browser console only

**Logs:**
- Console logging for debugging
- Implementation: `src/lib/stats.svelte.ts` for connection stats
- Recorded but not sent anywhere: ICE candidate types, ABR rung selections, buffer levels

**Analytics:**
- None

## CI/CD & Deployment

**Hosting:**
- Static file hosting only
- Supported: GitHub Pages, Cloudflare Pages, Netlify, or any static file server
- Deploy: Push to repo + GitHub Actions (or platform-specific CI)
- Zero infrastructure cost

**CI Pipeline:**
- GitHub Actions workflow (not in this repo, deployment config only)
- Build: `bun run build && node scripts/spa-fallback.js`
  - Output: `build/` directory (static files)
  - Fallback: Copies `build/index.html` to `build/404.html` for GitHub Pages SPA routing
- Test: `bun run test:e2e` (Playwright tests)
- Lint: `bun run lint` (Prettier + ESLint)

## Environment Configuration

**Required env vars:**
- None - the app works with zero configuration in production

**Optional env vars (build-time):**
- `BASE_PATH` - Deployment path prefix for GitHub Pages (e.g., `/SyncStream`)
- `PUBLIC_TURN_URLS` - Comma-separated TURN server URLs (with `turn:` scheme)
- `PUBLIC_TURN_USERNAME` - TURN server username
- `PUBLIC_TURN_CREDENTIAL` - TURN server credential
- `VITE_LOCAL_RELAY` - Localhost relay URL for e2e tests (test builds only)

**Optional env vars (test-time):**
- `CI` - Set by GitHub Actions, changes retry/reporter behavior in Playwright config

**Secrets location:**
- None in repository
- Env vars are static at build time (not runtime secrets)
- TURN credentials (if used) are publicly visible in the bundle (design constraint)

## Webhooks & Callbacks

**Incoming:**
- None - this is a client-only application with no backend

**Outgoing:**
- None - no external APIs are called at runtime

## Data Flow Summary

1. **Host** opens local MP4 file (File API)
2. **Host** probes file with mp4box (format, codec support)
3. **Host** announces presence on Nostr/MQTT relays via trystero (rendezvous)
4. **Guest** accesses share link with 6-char room code
5. **Guest** joins via rendezvous (tries Nostr first, falls back to MQTT)
6. **WebRTC connection** established (STUN ICE candidates, or TURN if configured)
7. **Host and Guest** exchange SDP/ICE via trystero (Nostr/MQTT)
8. **Raw RTCPeerConnection** opens data channels with custom framing
9. **Guest** requests segments via `syncstream://` scheme over data channel
10. **Host** reads byte ranges, encodes to quality tiers (mp4-muxer + WebCodecs)
11. **Segments** stream to guest over WebRTC
12. **Shaka Player** plays segments with ABR and MSE buffer management
13. **Name** persisted to localStorage (optional, user-initiated)

All media stays between peers (host's uplink only). No infrastructure touches user video.

---

*Integration audit: 2026-07-28*
