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
 * Why something the room was asked for cannot happen, said so a screen can
 * act on it rather than merely quote it.
 *
 * Every failure that reaches a person used to travel as prose: the probe's
 * sentence, Shaka's "error 4032", a thrown message. Prose cannot be branched
 * on, so each screen that showed one grew its own ad hoc wording, and a test
 * could only match substrings. The code is the stable part - what the UI picks
 * its advice by and what a test asserts - and the sentences hang off it.
 *
 * `detail` is written for the person who owns the thing that failed (the host
 * for a file, the guest for a browser), and `remedy` is what they can do,
 * which may be nothing. Every screen that renders one goes through
 * FaultNotice, so the shape is rendered once.
 */
export type FaultCode =
	/** Not an MP4 the origin can index: another container, or an already-fragmented one. */
	| 'container'
	/** An MP4 with no usable index: truncated or damaged. */
	| 'damaged'
	/** A track's codec cannot be decoded on the host, so it cannot be served. */
	| 'codec'
	/** Keyframes too far apart to cut a seekable segment grid. */
	| 'keyframes'
	/** No audio and no video track at all. */
	| 'empty'
	/** The host's browser lacks something the pipeline needs (MSE, WebCodecs). */
	| 'browser'
	/** The file needs converting and the encoder could not start. */
	| 'encoder'
	/** The picker's own refusals: a folder, several files, a non-video. */
	| 'not-video'
	/** This browser cannot play the stream the host is serving. */
	| 'unsupported-here'
	| 'unknown';

export type Fault = {
	code: FaultCode;
	/** One sentence naming the cause. */
	detail: string;
	/** What the reader can do about it, when there is something. */
	remedy?: string;
};

/** An Error that carries a Fault, so a catch can render it rather than quote it. */
export class FaultError extends Error {
	readonly fault: Fault;
	constructor(fault: Fault) {
		super(fault.detail);
		this.name = 'FaultError';
		this.fault = fault;
	}
}

/** Any thrown thing as a Fault, so a catch never has to guess the shape. */
export function faultOf(err: unknown, code: FaultCode = 'unknown'): Fault {
	if (err instanceof FaultError) return err.fault;
	const detail = err instanceof Error ? err.message : String(err);
	return { code, detail };
}

/** Runtime check for a Fault off the wire. A peer's message is typed, not trusted. */
export function isFault(x: unknown): x is Fault {
	if (typeof x !== 'object' || x === null) return false;
	const f = x as Record<string, unknown>;
	return (
		typeof f.code === 'string' &&
		typeof f.detail === 'string' &&
		(f.remedy === undefined || typeof f.remedy === 'string')
	);
}

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

/**
 * Host is segmenting and the manifest is valid.
 *
 * `title` is the film's name, and it is the host's to state for the same reason
 * `Roster` is: the file is on the host's disk and nowhere else, so a guest has
 * no way to know what it is watching except by being told. Carried here rather
 * than in a message of its own because the name and the film arrive together and
 * stop being true together - a second film supersedes both at once.
 */
export type Ready = {
	t: 'ready';
	mpd: string;
	duration: number;
	title: string;
	/**
	 * Which film this is, as the host names it: a fresh random id per `setFile`.
	 *
	 * Segment keys are `repId/track/segIdx`, which is content-addressing by
	 * convention and not by digest, and the convention breaks the moment the host
	 * puts on a second film: segment 3 of the new film and segment 3 of the old
	 * share a key, and a guest's cache or the host's tracker will serve one for
	 * the other. The id is what tells them apart. It rides every segment request
	 * and every cache announcement, and anything stamped with a film that is not
	 * the one on is ignored. A guest also dedupes a repeated `ready` by it: the
	 * host re-sends `ready` for the film already playing, and the manifest text
	 * alone cannot tell a repeat from a renamed copy of the same file.
	 */
	film: string;
	/**
	 * The rungs warm at this moment (see `Rungs`), carried here as well because
	 * the guest decides its FIRST variant during `load()`, and `load()` starts
	 * the instant `ready` lands. A separate `rungs` message sent right after
	 * arrives in time only by luck; without it the guest opened unrestricted,
	 * its bandwidth guess picked 360p, and every first frame was the bottom rung.
	 */
	rungs: number[];
};

/** Host cannot serve this file at all (PLAN.md 4.3 tier 3), with a real reason. */
export type Unplayable = { t: 'unplayable'; fault: Fault };

/**
 * The host tried to change the film and could not build the new one. The film
 * already on keeps playing everywhere, which is why this is its own message and
 * not `unplayable`: a guest mid-film has a player on screen and the rejection
 * must not read as that film failing.
 */
export type SwitchFailed = { t: 'switchFailed'; title: string; fault: Fault };

/**
 * This guest's player could not load the film at all, so it will send no
 * `status` for it and must not be waited on.
 *
 * Without this a guest whose browser cannot play the stream kept reporting an
 * empty buffer, the readiness barrier held the whole room for it, and every
 * other screen read "Waiting for Sam to catch up" about a stall no connection
 * could end. The host removes the sender from the barrier and says what is
 * actually wrong, by name.
 */
export type CannotPlay = { t: 'cannotPlay'; film: string; fault: Fault };

export type SegReq = {
	t: 'segReq';
	reqId: number;
	repId: number;
	track: Track;
	/** INIT_SEGMENT for the init segment. */
	segIdx: number;
	/** The film this key belongs to (see `Ready.film`). */
	film: string;
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

/**
 * Guest asks; the host decides and broadcasts. A guest may ask for play or
 * pause only: scrubbing is the host's alone, so a guest's `seek` is dropped on
 * arrival. `seek` stays in the type because the host's own controls go through
 * the same funnel.
 */
export type Intent = {
	t: 'intent';
	action: 'play' | 'pause' | 'seek';
	mediaTime: number;
};

/**
 * Whether the host should act on an intent a guest sent. Play and pause only:
 * scrubbing is the host's alone. Checked on arrival because `decodeControl`
 * types a message without validating it, and a guest is a peer we do not
 * control, so an action this app never sends is refused here too.
 */
export function guestMayAsk(i: Intent): boolean {
	return i.action === 'play' || i.action === 'pause';
}

/**
 * Who stopped the film, so the room can say why it stopped.
 *
 * Anyone may pause: a guest sends `intent` and the host obeys it, which means a
 * film can halt for everybody at the request of somebody they cannot see. The
 * `state` that carries the halt is deliberately anonymous - it is absolute,
 * idempotent playback truth, and who asked for it is not part of that - so the
 * attribution rides its own message.
 *
 * `by` is null when nothing deliberate stopped the film: the barrier's brake has
 * a banner of its own, and a film that simply ended was not paused by anyone.
 *
 * Sent per link and carrying `you`, for the reason `Waiting` and `Roster` do:
 * the one reader who must not be told "Bob paused the film" is Bob. `you` is the
 * host's answer and not a name match, which two guests sharing a name would
 * break.
 */
export type Paused = { t: 'paused'; by: string | null; you: boolean };

/** Guest health for the readiness barrier (PLAN.md 7, Phase 3). */
export type Status = {
	t: 'status';
	bufferedAhead: number;
	/** Fully buffered through the ending, or already ended. Older guests omit it. */
	atEnd?: boolean;
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
 * Sent per link and not broadcast, for the reason `Waiting` is: `guests`
 * excludes the recipient, because a guest is never told which name is theirs
 * and would read their own name as a stranger's.
 *
 * The host is its own field rather than the first of a flat list. A receiver
 * asks two different questions of this - who is in the room (host included) and
 * who else is *waiting* alongside me (host excluded, since the screen that asks
 * has already named them) - and the second is unanswerable from a list whose
 * host is identified only by position.
 */
export type Roster = { t: 'roster'; host: string; guests: string[] };

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
export type Have = { t: 'have'; film: string; keys: string[] };
export type SourcesReq = { t: 'sourcesReq'; reqId: number; film: string; keys: string[] };
export type SourcesRes = { t: 'sourcesRes'; reqId: number; sources: Record<string, string[]> };

/**
 * Phase 5 fetch diversity: the host deals each guest a prefetch stripe.
 *
 * Phase 3 keeps every guest's playhead and buffer aligned, so left alone the
 * room asks the host for the same segment in the same instant, four times over,
 * and no guest's cache is ever a useful answer for another's next fetch - the
 * measured 720p equilibrium in PLAN.md 11. The stripe is what breaks that
 * symmetry: a guest prefetches ahead of its playhead only the segments where
 * `segIdx % of === slot`, so each segment leaves the host once and the mesh
 * carries it to everyone else.
 *
 * The host assigns it because the host is the only complete view of the room
 * (see `Roster`): guests deriving stripes from their own peer lists would
 * disagree, and two guests on one stripe is the duplicate fetch this exists to
 * remove. A stale plan is harmless - ownership steers optimization only, and
 * every fetch still falls back to the host - so this is re-dealt on every join
 * and leave rather than negotiated.
 *
 * `rungs` is the set of rungs the room is currently playing, from the same
 * status reports the readiness barrier runs on, and it exists because a stripe
 * owner prefetching only its own rung leaves a hole exactly when the room is
 * split: a guest already at native never pulls the 480p copies of its stripes,
 * so the guests still below fetch those from the host in aligned lockstep, the
 * duration-weighted ABR estimator reads only that slow residue however many
 * instant peer fetches surround it, and the stragglers park. Owners covering
 * every rung in play is what closes the hole; when the room converges the set
 * collapses to [0] and the extra cost collapses with it.
 */
export type MeshPlan = { t: 'meshPlan'; slot: number; of: number; rungs: number[] };

export type ControlMessage =
	| Hello
	| Rename
	| Ready
	| Unplayable
	| SwitchFailed
	| CannotPlay
	| SegReq
	| SegErr
	| SegCancel
	| Ping
	| Pong
	| State
	| Intent
	| Paused
	| Status
	| Waiting
	| Roster
	| Rungs
	| Have
	| SourcesReq
	| SourcesRes
	| MeshPlan;

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
