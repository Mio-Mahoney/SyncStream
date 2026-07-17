# SyncStream

Open a video off your own disk and watch it together, in sync. Nothing uploads, nothing transcodes in the cloud, and there is no waiting for a download to finish before the first frame.

**There is no backend.** The site is static, the media is peer-to-peer, and the host's own uplink is the only transport. Total fixed cost: zero. See [PLAN.md](PLAN.md) for why, and for what it cost to get there.

## How it works

The host is an origin server for its own local file. It never reads the whole thing: it reads byte ranges on demand with `File.slice()` and packages them into CMAF segments in the browser. Guests request segments over a WebRTC data channel and play them through Shaka Player, which handles buffering and adaptive bitrate. Quality becomes a per-segment choice, which is the whole point.

Measured against a 2 GB file: first frame in 4.9s, seek in 43ms, under 125MB of JS heap on either side.

```
src/lib/
  rendezvous/   finding each other (trystero over Nostr/MQTT/Supabase)
  rtc/          raw RTCPeerConnection, framing, backpressure
  media/        probe, segmentation, MPD, WebCodecs ladder, Shaka glue
  sync/         clock offset, authoritative playback state, readiness barrier
  mesh/         guests serving segments to each other
  room/         the host and guest halves, composed
```

## Develop

```bash
bun install
bun run dev
```

Open the app, click **Create room**, pick a video, and share the invite link. Add `?debug` to any URL for the live stats overlay (throughput, buffer depth, RTT, clock offset, drift, current rung, ICE candidate type).

## Build

```bash
bun run build     # -> build/, static files only
bun run preview
```

Deploys to any static host. `static/_redirects` covers SPA routing on Cloudflare Pages and Netlify.

## Test

```bash
bash tests/fixtures/gen.sh     # needs ffmpeg; the committed fixtures
bun run test:e2e
```

The e2e tests drive two real browser contexts and assert against `window.__syncstream`, the same instrumentation the debug overlay reads. Two tests need the large fixture and skip without it:

```bash
bash tests/fixtures/gen.sh --large   # ~2GB, gitignored, slow
```

Rendezvous uses public Nostr relays, so the suite needs network access.

## Rendezvous configuration

Nostr and MQTT need no account and have no quota, so they work out of the box. To put Supabase Realtime at the front of the ladder, set:

```
PUBLIC_SUPABASE_URL=...
PUBLIC_SUPABASE_ANON_KEY=...
```

Without them, Supabase reports itself unconfigured and the ladder skips it at no cost.

## Platform support

Hosting is a desktop job: it reads a multi-gigabyte local file and may run hardware encodes for hours. Guests are anything, including iOS via `ManagedMediaSource`. Every capability is feature-detected, never inferred from a user agent.
