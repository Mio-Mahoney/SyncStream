# Architecture

**Analysis Date:** 2026-07-28

## System Overview

SyncStream is a peer-to-peer video streaming application with no backend server. The host acts as an origin server for their local file, while guests request segments over WebRTC. The architecture prioritizes: (1) no server, (2) no cloud transcoding, (3) first frame in ~5s on large files.

```text
┌─────────────────────────────────────────────────────────────┐
│                    Browser UI (Svelte)                      │
│  Landing Page | Room Page | Components (FilePicker, etc.)  │
│           `src/routes/`, `src/lib/*.svelte`                 │
├──────────────────┬──────────────────┬───────────────────────┤
│  Host Room       │   Guest Room     │    Rendezvous         │
│ (room/host.ts)   │ (room/guest.ts)  │   (rendezvous/*.ts)   │
└────────┬─────────┴────────┬─────────┴──────────┬────────────┘
         │                  │                     │
         ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│           RTC Layer & Protocol                              │
│  Peer Network  | Channels  | Control Messages               │
│  `rtc/`        | `protocol/control.ts`                      │
└────────┬─────────────────────────────────────────────────────┘
         │
    ┌────┴──────────────────────────────┐
    │                                    │
    ▼                                    ▼
┌──────────────────────┐      ┌──────────────────────┐
│  Media Processing    │      │   Mesh Distribution  │
│  (Host-side encode)  │      │   (Guest-to-guest)   │
│  `media/`            │      │   `mesh/`            │
│  Probe, Segmentation │      │                      │
│  Ladder, Shaka       │      │   Phase 5 Optimiz.   │
└──────────────────────┘      └──────────────────────┘
    │
    ▼
┌─────────────────────┐
│  Sync Engine        │
│  `sync/`            │
│  Clock offset       │
│  Playback state     │
│  Readiness barrier  │
└─────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| **Landing Page** | Room creation/join UI | `src/routes/+page.svelte` |
| **Room Page** | Main video watching interface | `src/routes/room/[id]/+page.svelte` |
| **Host Room** | Orchestrates host-side logic, file selection, state authority | `src/lib/room/host.ts` |
| **Guest Room** | Orchestrates guest-side logic, segment fetching, playback | `src/lib/room/guest.ts` |
| **Rendezvous** | Discovers peers via Nostr/MQTT/Supabase relay ladder | `src/lib/rendezvous/room.ts` |
| **Rendezvous Transport** | Strategy adapter layer | `src/lib/rendezvous/transport.ts` |
| **RTC Connection** | Manages RTCPeerConnection, channel attachment, peer discovery | `src/lib/rtc/connection.ts` |
| **RTC Channel** | Data channel framing and backpressure | `src/lib/rtc/channel.ts` |
| **Protocol** | Control message types (hello, ready, state, intent) | `src/lib/protocol/control.ts` |
| **Media/Origin** | Assembles probe, source, ladder, manifest | `src/lib/media/origin.ts` |
| **Media/Probe** | Inspects file codec support, determines tier | `src/lib/media/probe.ts` |
| **Media/Source** | Reads byte ranges from File, emits rep 0 CMAF segments | `src/lib/media/source.ts` |
| **Media/Ladder** | Generates lower bitrate rungs via WebCodecs encode | `src/lib/media/ladder.ts` |
| **Media/Manifest** | Builds DASH MPD from probe result and ladder | `src/lib/media/manifest.ts` |
| **Shaka Config** | Configures Shaka Player, ABR restrictions | `src/lib/media/shaka/config.ts` |
| **Shaka Scheme** | Custom URI scheme handler for SyncStream segments | `src/lib/media/shaka/scheme.ts` |
| **Sync/Clock** | NTP-style clock sync between host and guest | `src/lib/sync/clock.ts` |
| **Sync/State** | Playback state authority (host) and follower (guest) | `src/lib/sync/state.ts` |
| **Mesh** | Peer-to-peer segment distribution, cache management | `src/lib/mesh/mesh.ts` |
| **Stats** | Instrumentation for testing and debug overlay | `src/lib/stats.svelte.ts` |

## Pattern Overview

**Overall:** Event-driven, reactive peer-to-peer architecture with a strict host-authority pattern.

**Key Characteristics:**
- **No server:** Static HTML/JS/CSS only. All coordination through WebRTC data channels.
- **Host is authority:** Playback state, file manifest, and media bytes all originate from host. Guests send intent only.
- **Pull-based media:** Guests request segments by (repId, track, segIdx). Host answers or mesh peers do. All segments eventually fetchable from host.
- **Reactive state:** Uses Svelte runes ($state, $derived, $effect) for UI reactivity and state management.
- **Layered responsibility:** Rendezvous → RTC → Protocol → Sync → Media, with clear boundaries.

## Layers

**Layer 1: UI/Routes**
- Purpose: Render landing page, room, and components
- Location: `src/routes/`, `src/lib/*.svelte`
- Contains: Svelte pages and components
- Depends on: Room (host/guest), identity, stats
- Used by: Browser display

**Layer 2: Room Orchestration**
- Purpose: Coordinate host-side or guest-side behavior
- Location: `src/lib/room/host.ts`, `src/lib/room/guest.ts`
- Contains: HostRoom and GuestRoom implementations
- Depends on: Rendezvous, RTC, Sync, Media, Mesh, Protocol
- Used by: Route pages

**Layer 3: Rendezvous**
- Purpose: Discover and connect to peers via public relays
- Location: `src/lib/rendezvous/`
- Contains: Room-level policy, transport adapters (Trystero, Local, Nostr, MQTT, Supabase)
- Depends on: @trystero-p2p libraries
- Used by: Host and guest rooms
- Key files:
  - `room.ts`: PLAN.md 4.6/4.7 - occupancy probe, strategy ladder
  - `transport.ts`: Abstract session interface
  - `trystero.ts`: Trystero adapter
  - `local.ts`: Localhost relay for testing (hermetic e2e)
  - `codes.ts`: Room code generation/validation

**Layer 4: RTC/Networking**
- Purpose: Establish WebRTC connections and manage data channels
- Location: `src/lib/rtc/`
- Contains: RTCPeerConnection management, channel attachment, ICE candidate inspection
- Depends on: Protocol
- Used by: Host and guest rooms
- Key files:
  - `connection.ts`: Peer discovery and network management
  - `channel.ts`: Control and segment data channels with framing/backpressure
  - `ice.ts`: ICE candidate type inspection (host/srflx/prflx/relay)

**Layer 5: Protocol**
- Purpose: Define control message types and wire format
- Location: `src/lib/protocol/control.ts`, `protocol/wire.ts`
- Contains: Hello, Ready, State, Intent, Roster, SegReq, etc. message types
- Depends on: None (pure types)
- Used by: Room, RTC, Sync, Mesh
- Key invariants (PLAN.md 7):
  - Host is sole authority for playback state
  - Guests send intent, never state
  - State carries absolute values, never relative toggles

**Layer 6: Sync Engine**
- Purpose: Synchronize playback state and clock between host and guest
- Location: `src/lib/sync/`
- Contains: NTP-style clock sync, playback state machine, readiness barrier
- Depends on: Protocol
- Used by: Host and guest rooms
- Key files:
  - `clock.ts`: NTP round-trip time estimation
  - `state.ts`: Playback state authority (HostState) and follower (GuestSync), barrier logic
- **UNITS:** mediaTime and currentTime in SECONDS; atHostClock and hostNow() in MILLISECONDS

**Layer 7: Media Processing**
- Purpose: Segment local file, generate adaptive bitrate ladder, produce DASH MPD
- Location: `src/lib/media/`
- Contains: Probe, Source, Ladder, Manifest, Shaka integration
- Depends on: Protocol, WebCodecs, shaka-player
- Used by: Host room
- Key flow:
  1. Probe (codec support, file tier)
  2. Source (read byte ranges, emit rep 0 CMAF)
  3. Ladder (encode lower bitrate rungs from rep 0)
  4. Manifest (DASH MPD describing all rungs)
- Key files:
  - `probe.ts`: Tier 1 (native), Tier 2 (transcode), Tier 3 (reject)
  - `source.ts`: CMAF segmentation with mp4box
  - `ladder.ts`: WebCodecs encode worker, lazy rung generation
  - `manifest.ts`: DASH MPD builder
  - `shaka/config.ts`: Shaka Player ABR restrictions
  - `shaka/scheme.ts`: Custom URI scheme handler ("syncstream://...")

**Layer 8: Mesh Distribution (Phase 5)**
- Purpose: Optimize host uplink by having guests serve segments to each other
- Location: `src/lib/mesh/mesh.ts`
- Contains: Segment cache, peer throughput tracking, segment routing
- Depends on: Protocol, RTC
- Used by: Guest room (Shaka scheme handler)
- Key constraint: **Host always available as fallback.** Mesh is optimization, not transport.
- Segment routing: Query tracker → prefer fastest peer → timeout/error → fetch from host

## Data Flow

### Primary Request Path: Host Playing Video

1. Host opens room via landing page (`src/routes/+page.svelte`, `createRoom()`)
2. Generates room code, navigates to `/room/[id]?create=1`
3. Room page mounts (`src/routes/room/[id]/+page.svelte`)
4. `startHostRoom()` called, initiates rendezvous announce (`src/lib/room/host.ts`)
5. Rendezvous walks strategy ladder (Nostr/MQTT/Supabase)
6. Host says hello on control channel: `{ t: 'hello', role: 'host', name }` (PLAN.md 7)
7. Host picks file via FilePicker
8. `setFile()` probes codec support, creates Origin (probe → source → ladder → manifest)
9. Host ready message: `{ t: 'ready', mpd, duration, title }`
10. Guests request segments via `segReq`: `{ t: 'segReq', repId, track, segIdx }`
11. Host sends segment data on peer channel
12. Sync engine broadcasts playback state: `{ t: 'state', playing, mediaTime, atHostClock, seq }`

### Guest Join Path

1. Guest opens share link or enters room code
2. Route to `/room/[id]`
3. Room page mounts, `startGuestRoom()` called (`src/lib/room/guest.ts`)
4. Rendezvous joins room by code
5. Peer discovered, control channel opens
6. Guest sends hello: `{ t: 'hello', role: 'guest', name }`
7. Host replies with roster, guest listens for ready message
8. On ready, Shaka player registered with SyncStream scheme
9. Segment requests flow through mesh (`mesh/mesh.ts`) → peer or host
10. Sync engine corrects playback via `GuestSync` following host clock

### Segment Request Flow (Phase 5 Mesh)

1. Shaka Player needs segment at (repId, track, segIdx)
2. Calls SyncStream scheme handler (`shaka/scheme.ts`)
3. Mesh queries tracker for segment sources (`mesh/mesh.ts`)
4. Selects fastest peer with best throughput estimate
5. Sends `segReq` to peer
6. On timeout/error, falls back to host
7. Segment data arrives on peer channel, reassembled to full blob
8. Returned to Shaka for decode/buffer

### State Synchronization (Phase 3)

1. Host or guest sends intent: `{ t: 'intent', action: 'play'|'pause'|'seek', mediaTime }`
2. Host applies intent, emits state: `{ t: 'state', playing, mediaTime, atHostClock, seq }`
3. Guest receives state, applies to video element
4. Guest measures offset: `mediaTime - (nowMs() - atHostClock) / 1000`
5. If error > DEADBAND_SEC (0.05s), correct via rate nudge or seek
6. Heartbeat every HEARTBEAT_MS (1000ms) re-anchors guest to host clock

## Key Abstractions

**HostRoom:**
- Purpose: Stateful host representing one room's host role
- Examples: `src/lib/room/host.ts`
- Pattern: Factory function returning object with methods (setFile, intent, close) and properties (code, state, barrier)
- Exports: code (announced), shareUrl, HostState (playback authority), ReadinessBarrier (buffer-based gate)

**GuestRoom:**
- Purpose: Stateful guest representing one room's guest role
- Examples: `src/lib/room/guest.ts`
- Pattern: Same factory + methods pattern
- Exports: Shaka player, methods for intent/naming

**HostState / GuestSync:**
- Purpose: Playback state machine + NTP clock sync
- Examples: `src/lib/sync/state.ts`
- Pattern: Class-based, separate host (authority) and guest (follower) implementations
- Semantics: Absolute state always; guests never send state to each other

**Origin:**
- Purpose: Bundle of probe result, source reader, ladder encoder, manifest builder
- Examples: `src/lib/media/origin.ts`
- Pattern: Async factory returning object with methods (getSegment, getInit)
- Exports: Segment bytes by (repId, track, segIdx); playable MPD

**Ladder:**
- Purpose: Lazy encoder pool for ABR rungs
- Examples: `src/lib/media/ladder.ts`
- Pattern: Worker-backed encode queue; segments warmed on demand
- Semantics: Rep 0 (native passthrough) + N transcode rungs; SEGMENT_CACHE_BYTES budget

**Mesh:**
- Purpose: Segment router with peer throughput tracking
- Examples: `src/lib/mesh/mesh.ts`
- Pattern: Fetcher wrapping Fetcher (composable)
- Semantics: Query → peer selection → timeout → host fallback; always converges

**RendezvousSession:**
- Purpose: Transport-independent peer session
- Examples: `src/lib/rendezvous/transport.ts`
- Pattern: Protocol adapter; each strategy (Nostr, MQTT, etc.) returns this
- Exports: RTCPeerConnection, onPeer, onControl, leave()

## Entry Points

**Web Entry Point:**
- Location: `src/routes/+layout.svelte`
- Triggers: Browser load of `/` or `/room/[id]`
- Responsibilities: Render shell, apply global CSS, children routes

**Landing Page:**
- Location: `src/routes/+page.svelte`
- Triggers: Browser load of `/`
- Responsibilities: Room creation (generateRoomCode), room joining (normalizeRoomCode), forward strategy param

**Room Page:**
- Location: `src/routes/room/[id]/+page.svelte`
- Triggers: Browser load of `/room/[code]` or `/room/[code]?create=1`
- Responsibilities: Orchestrate host or guest room, render video player, UI controls

**Host Room Init:**
- Location: `src/lib/room/host.ts`, `startHostRoom()`
- Triggers: Room page's `const host = await startHostRoom(opts)`
- Responsibilities: Rendezvous announce, peer network creation, file selection handler

**Guest Room Init:**
- Location: `src/lib/room/guest.ts`, `startGuestRoom()`
- Triggers: Room page's `const guest = await startGuestRoom(opts)`
- Responsibilities: Rendezvous join, peer network creation, Shaka player setup

## Architectural Constraints

- **Threading:** Single-threaded event loop (browser). WebCodecs encoding offloaded to worker (`media/worker/encode.worker.ts`).
- **Global state:** Minimal. Each room page holds one HostRoom or GuestRoom. Stats singleton for instrumentation only.
- **Circular imports:** None known. Imports flow upward through layers.
- **Module-level singletons:** 
  - ClockSync (per room, not global)
  - Stats (global, for debug overlay only)
  - Ladder worker pool (per Origin, scoped)
- **No server:** Everything static. Coordination via WebRTC data channels only.
- **Memory:** Bounded by SEGMENT_CACHE_BYTES (~64MB) + Shaka's own buffer + encode worker frames.

## Anti-Patterns

### Relative State Toggles in Playback

**What happens:** Sending `play` or `pause` instead of absolute `{ playing: true/false }` state.

**Why it's wrong:** Idempotency breaks. Two `pause` messages in flight with one lost desyncs the room. Absolute state can be dropped, duplicated, reordered, replayed and still converge (PLAN.md 7).

**Do this instead:** Always emit absolute state from host: `{ t: 'state', playing: true, mediaTime: 42.5, atHostClock: ..., seq: ... }`. Guests apply it directly without reading current state.

### Guest-to-Guest State Communication

**What happens:** Guests relay playback state to each other instead of going through host.

**Why it's wrong:** Room desynchronizes. Guests have different network latencies and may receive messages out of order. Host is the single source of truth.

**Do this instead:** Only host broadcasts state (via `broadcastControl`). Guests receive from host only. Guest-to-guest traffic is Phase 5 mesh (segments only), never control.

### Ignoring Probe Tier in Media Handling

**What happens:** Treating a Tier 2 file (needs transcode) the same as Tier 1 (native playback).

**Why it's wrong:** File becomes unplayable or playback is blocked by encode latency.

**Do this instead:** Probe file first (`media/probe.ts`). Tier 1 → serve native. Tier 2 → spawn ladder encoder. Tier 3 → reject with reason.

## Error Handling

**Strategy:** Layered with fallback chains.

**Patterns:**
- **Rendezvous:** Walk strategy ladder (PLAN.md 4.6). One relay fails → try next. All fail → RendezvousError with attempts list.
- **Peer connection:** ICE fails → fallback to TURN if configured. No TURN → connection fails, error bubbles to UI.
- **Segment fetch:** Peer timeout → fallback to host. Host timeout → playlist stops, buffered content plays down.
- **File probe:** Tier 3 rejection → show reason to user, no file served.
- **Codec encode:** Encoder misconfiguration → reject file before serving MPD.

## Cross-Cutting Concerns

**Logging:** `console.error()` for errors; `console.log()` for debug (not production). Stats object captures events for telemetry.

**Validation:** 
- Room code: `isValidRoomCode()` (6 uppercase alphanumeric)
- Message types: Runtime checks in control message handlers
- Manifest: Shaka Player validates MPD structure

**Authentication:** None. Rendezvous is per-code (code is low-entropy, best-effort). TURN credentials (if configured) ship in static bundle (short-lived recommended).

**Rate limiting:** Segment requests are flow-controlled by Shaka's buffer depth. Heartbeat: 1/s. Announce: 1/s.

---

*Architecture analysis: 2026-07-28*
