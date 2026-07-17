/**
 * JSON control protocol (PLAN.md 7, Phases 2/3/5).
 *
 * Rules that hold across every message here:
 *  - The host is the sole authority for playback state and the sole source of
 *    truth for media bytes (PLAN.md 4.9). Guests send *intent*, never commands.
 *  - Guests never send playback state to each other. The only guest-to-guest
 *    traffic is Phase 5 segment exchange, which cannot affect correctness.
 *  - `state` carries absolute values, never relative toggles, so it is
 *    idempotent and safe to re-apply or drop.
 */

export type Track = 'video' | 'audio';

/** segIdx sentinel for a representation's init segment. */
export const INIT_SEGMENT = -1;

export type Role = 'host' | 'guest';

/**
 * First message on every control channel. Establishes which peer is the host,
 * which is also how a would-be host detects that a room code is already
 * occupied (PLAN.md 4.7).
 */
export type Hello = { t: 'hello'; role: Role; name: string };

/**
 * A peer has said who it is, replacing whatever it introduced itself as.
 *
 * Needed because the name on `hello` is a fallback the machine invented: the
 * invite link opens a room straight away by design, so a guest is already in it,
 * already announced, and already on the host's presence line before they have
 * had any chance to say who they are. Without this, naming yourself would mean
 * rejoining, and the host would watch you leave and a stranger arrive.
 *
 * Either role may send it. A guest's goes to the host, who owns every name in
 * the room and re-states the roster; the host's is broadcast, because a guest
 * still waiting for a file knows the host only by the name on its hello and
 * would otherwise read the old one until the roster's next send.
 */
export type Rename = { t: 'rename'; name: string };

/** Host is segmenting and the manifest is valid. */
export type Ready = { t: 'ready'; mpd: string; duration: number };

/** Host cannot serve this file at all (PLAN.md 4.3 tier 3), with a real reason. */
export type Unplayable = { t: 'unplayable'; reason: string };

export type SegReq = {
	t: 'segReq';
	reqId: number;
	repId: number;
	track: Track;
	/** INIT_SEGMENT for the init segment. */
	segIdx: number;
};

/** Payload rides the data channel as SegData frames keyed by reqId. */
export type SegErr = { t: 'segErr'; reqId: number; reason: string };

export type SegCancel = { t: 'segCancel'; reqId: number };

/** NTP-style clock estimation (PLAN.md 7, Phase 3). */
export type Ping = { t: 'ping'; t0: number };
export type Pong = { t: 'pong'; t0: number; t1: number };

/** Authoritative playback state. `seq` is monotonic; guests drop stale ones. */
export type State = {
	t: 'state';
	playing: boolean;
	mediaTime: number;
	atHostClock: number;
	seq: number;
};

/** Guest asks; the host decides and broadcasts. */
export type Intent = {
	t: 'intent';
	action: 'play' | 'pause' | 'seek';
	mediaTime: number;
};

/** Guest health for the readiness barrier (PLAN.md 7, Phase 3). */
export type Status = {
	t: 'status';
	bufferedAhead: number;
	rung: number | null;
	throughput: number;
	name: string;
};

/**
 * Host tells the room who it is waiting for, so guests can show it too.
 *
 * Sent per link rather than broadcast, because the one guest who cannot read
 * "Waiting for Guest 412" is Guest 412: nothing ever tells a guest which name
 * is theirs, so the person whose stall froze the film is the only reader who
 * cannot tell the banner is about them. `on` therefore excludes the recipient
 * and `you` says whether the recipient is one of the guests being waited on.
 */
export type Waiting = { t: 'waiting'; on: string[]; you: boolean };

/**
 * Host tells each guest who they are watching with: itself, plus every other
 * guest. The room's population is the host's to state, and only the host's.
 *
 * A guest cannot answer this from its own peers, and the tempting assumption
 * that it can is wrong in a way that never heals: the Phase 5 mesh links guests
 * to each other opportunistically, not exhaustively, so a guest's peer list is
 * who it happens to be meshed with. Measured in a three-guest room, two guests
 * saw all three peers and the third saw only two - permanently. Rendering that
 * would tell someone they were watching with two people while three watched.
 * Every guest is connected to the host by definition, which is what makes the
 * host the one honest source.
 *
 * Sent per link and not broadcast, for the reason `Waiting` is: `people`
 * excludes the recipient, because a guest is never told which name is theirs
 * and would read their own name as a stranger's.
 */
export type Roster = { t: 'roster'; people: string[] };

/**
 * Which rungs are warm enough to select (PLAN.md 4.2, 4.5).
 *
 * Not in the plan's protocol sketch, but its rung-warmth rule needs a wire
 * message and this is it. The MPD lists every rung the host *can* produce,
 * because a static VOD manifest is fetched once and rebuilding it would not
 * reach a loaded player. Warmth therefore rides the control channel and lands
 * on Shaka's `abr.restrictions`, which is exactly what 4.5 prescribes: "cap
 * abr.restrictions where a rung is not yet generated".
 */
export type Rungs = { t: 'rungs'; available: number[] };

/** Phase 5 mesh. A guest announces newly cached segments to the host tracker. */
export type Have = { t: 'have'; keys: string[] };
export type SourcesReq = { t: 'sourcesReq'; reqId: number; keys: string[] };
export type SourcesRes = { t: 'sourcesRes'; reqId: number; sources: Record<string, string[]> };

export type ControlMessage =
	| Hello
	| Rename
	| Ready
	| Unplayable
	| SegReq
	| SegErr
	| SegCancel
	| Ping
	| Pong
	| State
	| Intent
	| Status
	| Waiting
	| Roster
	| Rungs
	| Have
	| SourcesReq
	| SourcesRes;

export type ControlType = ControlMessage['t'];

/** Key for a segment in caches, `have` sets, and the mesh tracker. */
export function segKey(repId: number, track: Track, segIdx: number): string {
	return `${repId}/${track}/${segIdx}`;
}

export function parseSegKey(key: string): { repId: number; track: Track; segIdx: number } | null {
	const parts = key.split('/');
	if (parts.length !== 3) return null;
	const repId = Number(parts[0]);
	const segIdx = Number(parts[2]);
	const track = parts[1];
	if (!Number.isInteger(repId) || !Number.isInteger(segIdx)) return null;
	if (track !== 'video' && track !== 'audio') return null;
	return { repId, track, segIdx };
}

export function encodeControl(msg: ControlMessage): string {
	return JSON.stringify(msg);
}

/**
 * Parses an untrusted control frame. Returns null rather than throwing: a peer
 * sending us garbage is a peer to ignore, not a reason to tear down the room.
 */
export function decodeControl(raw: string): ControlMessage | null {
	let val: unknown;
	try {
		val = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof val !== 'object' || val === null) return null;
	const t = (val as { t?: unknown }).t;
	if (typeof t !== 'string') return null;
	return val as ControlMessage;
}
