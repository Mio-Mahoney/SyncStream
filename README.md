# SyncStream

Open a video off your own disk and watch it together, in sync. Nothing uploads, nothing transcodes in the cloud, and there is no waiting for a download to finish before the first frame.

**There is no backend.** The site is static, the media is peer-to-peer, and the host's own uplink is the only transport. Total fixed cost: zero. See [PLAN.md](PLAN.md) for why, and for what it cost to get there.

## How it works

The host is an origin server for its own local file. It never reads the whole thing: it reads byte ranges on demand with `File.slice()` and packages them into CMAF segments in the browser. Guests request segments over a WebRTC data channel and play them through Shaka Player, which handles buffering and adaptive bitrate. Quality becomes a per-segment choice, which is the whole point.

What it measures today, and how, is in [STATUS.md](STATUS.md). [PLAN.md](PLAN.md) is the design and its history; [REVIEW.md](REVIEW.md) is the review the current round of fixes worked through.

```
src/lib/
  rendezvous/   finding each other (trystero over Nostr/MQTT, or the local test relay)
  rtc/          raw RTCPeerConnection, framing, backpressure, admission
  media/        probe, segmentation, MPD, WebCodecs ladder, Shaka glue
  sync/         clock offset, authoritative playback state, readiness barrier
  mesh/         guests serving segments to each other
  protocol/     the control messages, the wire framing, and the Fault type every failure travels as
  room/         the host and guest halves, composed
```

## The invite link

A room has a six-character **code** and a sixteen-character **key**. The code is the room's name: it is what the relays see, what is printed on screen, and all a stranger needs to find out that a room exists. The key is what joining takes. It rides in the link's fragment:

```
https://example.github.io/SyncStream/room/K7M4PQ?s=nostr#k=XXXXXXXXXXXXXXXX
```

The rendezvous layer encrypts every offer and answer with a key derived from it, so a peer holding the code alone can publish on the room's topic and decrypt nothing: no connection ever forms. Browsers never send a URL's fragment in an HTTP request, so the static host serving this page does not get a copy in its logs either. This is the whole of the trust model: anyone holding the link is in, and nobody else is. There are no accounts and no server to hold a list of who is allowed.

A link that has lost its fragment (chat clients sometimes trim it) is told apart from a link to nowhere, on the landing page and in the room, and the advice differs: ask the host to copy the link again, rather than re-check a code that was never the problem. Codes are no longer typed in by hand; the landing page takes the link.

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

Two tiers.

```bash
bun run test:unit              # Bun, milliseconds: the pure modules
bash tests/fixtures/gen.sh     # needs ffmpeg; the committed fixtures
bun run test:e2e               # Playwright, Chromium, minutes: the integration claims
```

The unit tier (`tests/unit/`) runs the modules that have no browser in them under Bun with fakes: wire framing and the reassembly caps, the control protocol and faults, the sync engine and readiness barrier, the manifest, the rung window policy, the mesh with an in-memory peer network. It is where a bug in any of those is reproduced first; the e2e tier is for claims that need two browsers and a media pipeline.

The e2e tests drive real browser contexts and assert against `window.__syncstream`, the same instrumentation the debug overlay reads. They pin rendezvous to a localhost relay (`tests/e2e/local-relay.ts`, selected with `?s=local`) so a public relay's bad minute cannot fail a run; `rendezvous.spec.ts` alone still walks the public ladder, and needs network access. A few specs need the large fixture and skip without it:

```bash
bash tests/fixtures/gen.sh --large   # ~2GB, gitignored, slow
```

`tests/e2e/scale.spec.ts` is the acceptance measurement for PLAN.md Phase 2 and prints its numbers; `STATUS.md` records them.

## Rendezvous configuration

Nostr and MQTT need no account and have no quota, so they work out of the box, and they are the whole production ladder. (Supabase Realtime was a third strategy once; it was removed after measurement, see `src/lib/rendezvous/transport.ts`.) A room announces on both at once and the invite link names the one that answered first, so a guest tries that one before walking the ladder.

## TURN configuration

Rendezvous only introduces two peers; the connection itself still has to cross both NATs. Public STUN handles ordinary residential NAT, which is most of them. Symmetric NAT and CGNAT cannot be traversed that way and need TURN, which relays every byte and is therefore the only cost in this design that scales with usage -- so it is absent by default ([PLAN.md](PLAN.md) §9).

Whether you need it is a measurement, not a guess. Open a room with `?debug` and read **candidate type** on a real cross-network guest:

- `host` / `srflx` / `prflx` -- connected directly. TURN would have changed nothing. The host's overlay shows the type per guest, refreshed every second; the guest's shows its own.
- `iceState: failed` -- this connection needed TURN. With none configured a `relay` candidate can never be gathered, so an *observed* ICE failure is what "needed TURN" looks like here. A connection that merely never finished opening inside the deadline is not counted: it is usually the same thing, but it is also what a host who closed the page a moment ago looks like, and the guest's screen says so with that hedge.

If that failure rate is high enough to matter:

```
PUBLIC_TURN_URLS=turn:example.com:3478,turns:example.com:5349
PUBLIC_TURN_USERNAME=...
PUBLIC_TURN_CREDENTIAL=...
```

TURN stays the fallback, never the default path (`iceTransportPolicy` is left at `all`), so directly-reachable peers never relay. Note these credentials ship inside a static bundle and are readable by anyone, so point them at something quota'd with short-lived credentials -- never a flat-rate relay you would mind strangers using. §9 has the coturn policy worth copying, including `denied-peer-ip` for RFC1918, since an open relay that reaches internal addresses is an SSRF pivot into your own network.

## Platform support

Hosting is a desktop job: it reads a multi-gigabyte local file and may run hardware encodes for hours. Guests are anything, including iOS via `ManagedMediaSource`. Every capability is feature-detected, never inferred from a user agent.
