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

Deploys to any static host, and the build is valid on all of them at once: `static/_redirects` covers SPA routing on Cloudflare Pages and Netlify, while `404.html` and `.nojekyll` cover GitHub Pages, which has no rewrite rules.

Pushing to `main` publishes to **<https://mio-mahoney.github.io/SyncStream/>** via `.github/workflows/deploy.yml`.

**HTTPS is not optional.** WebCodecs and `getUserMedia` need a secure context, so the tier-2 transcode path silently does not exist over plain HTTP. `localhost` counts as secure; a LAN IP does not.

### Serving from somewhere else

A GitHub Pages _project_ site lives under `/<repo>/`, so the build has to know that prefix or every asset 404s. `BASE_PATH` carries it:

```bash
BASE_PATH=/SyncStream bun run build   # what CI does
bun run build                         # root domain: custom domain, Cloudflare Pages
```

Nothing may construct a URL by hand -- route it through `$app/paths` or it will be correct on localhost and broken in production, which is the only place it is used.

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

## TURN configuration

Rendezvous only introduces two peers; the connection itself still has to cross both NATs. Public STUN handles ordinary residential NAT, which is most of them. Symmetric NAT and CGNAT cannot be traversed that way and need TURN, which relays every byte and is therefore the only cost in this design that scales with usage -- so it is absent by default ([PLAN.md](PLAN.md) §9).

Whether you need it is a measurement, not a guess. Open a room with `?debug` and read **candidate type** on a real cross-network guest:

- `host` / `srflx` / `prflx` -- connected directly. TURN would have changed nothing.
- `iceState: failed` -- this connection needed TURN. With none configured a `relay` candidate can never be gathered, so failure is what "needed TURN" looks like here.

If that failure rate is high enough to matter:

```
PUBLIC_TURN_URLS=turn:example.com:3478,turns:example.com:5349
PUBLIC_TURN_USERNAME=...
PUBLIC_TURN_CREDENTIAL=...
```

TURN stays the fallback, never the default path (`iceTransportPolicy` is left at `all`), so directly-reachable peers never relay. Note these credentials ship inside a static bundle and are readable by anyone, so point them at something quota'd with short-lived credentials -- never a flat-rate relay you would mind strangers using. §9 has the coturn policy worth copying, including `denied-peer-ip` for RFC1918, since an open relay that reaches internal addresses is an SSRF pivot into your own network.

## Platform support

Hosting is a desktop job: it reads a multi-gigabyte local file and may run hardware encodes for hours. Guests are anything, including iOS via `ManagedMediaSource`. Every capability is feature-detected, never inferred from a user agent.
