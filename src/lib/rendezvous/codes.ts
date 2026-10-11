/**
 * Room codes, generated client-side (PLAN.md 4.7).
 *
 * There is no server to allocate or check these, so they are drawn from
 * `crypto.getRandomValues`. Collision is handled at join time instead: a host
 * that finds its code already occupied regenerates (see `rendezvous/room.ts`).
 *
 * The alphabet is 32 characters: A-Z without I and O, digits 2-9. Excluding
 * the visually ambiguous pairs (0/O, 1/I) matters because people read these
 * codes aloud and type them from memory. 32 is also a power of two, so five
 * random bits map onto one character with no modulo bias and no rejection
 * sampling. 32^6 is just over a billion codes, which makes collision a
 * non-issue at any plausible concurrency.
 */

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

const BITS_PER_CHAR = 5; // 2^5 === CODE_ALPHABET.length

export function generateRoomCode(): string {
	if (CODE_ALPHABET.length !== 1 << BITS_PER_CHAR) {
		throw new Error('codes: alphabet must be exactly 32 characters for unbiased sampling');
	}
	const bytes = new Uint8Array(CODE_LENGTH);
	crypto.getRandomValues(bytes);
	let out = '';
	for (const b of bytes) {
		out += CODE_ALPHABET[b & ((1 << BITS_PER_CHAR) - 1)];
	}
	return out;
}

export function isValidRoomCode(code: string): boolean {
	if (code.length !== CODE_LENGTH) return false;
	for (const ch of code) {
		if (!CODE_ALPHABET.includes(ch)) return false;
	}
	return true;
}

/**
 * Coerces user input toward a valid code: uppercase, drop anything outside the
 * alphabet, clamp to length. Typing 'O' or '0' is a real mistake rather than a
 * guessable intent, so those are dropped rather than remapped.
 */
export function normalizeRoomCode(input: string): string {
	let out = '';
	for (const ch of input.toUpperCase()) {
		if (CODE_ALPHABET.includes(ch)) out += ch;
		if (out.length === CODE_LENGTH) break;
	}
	return out;
}

/**
 * Reads a code out of a link, where `normalizeRoomCode` reads one out of typing.
 *
 * Case is forgiven, because links get lowercased in transit and the code is no
 * less certain for it. Nothing else is: a link is copied, not typed, so a
 * character outside the alphabet means the link is damaged, and salvaging six
 * good characters from it would name some other room.
 *
 * This is the one definition of "a link that names a room". The join box reads
 * a pasted link with it, and `hooks.ts` and the room page read an opened one
 * with it, so a link cannot be good in one and broken in the other.
 */
export function parseRoomCode(value: string): string | null {
	const raw = value.trim();
	const code = normalizeRoomCode(raw);
	return isValidRoomCode(code) && code.length === raw.length ? code : null;
}

/**
 * The query parameter an invite link carries its code in: `/?room=K7M4PQ`.
 * `hooks.ts` is what makes that address serve the room, and says why the invite
 * is not simply the room's own path.
 */
export const ROOM_PARAM = 'room';

/**
 * The raw value of a URL's room parameter, or null if it has none. The name is
 * matched in any case for the reason the code is: `?ROOM=` is the same link
 * after a rough trip, and the join box has always read it as one.
 */
export function roomParam(params: URLSearchParams): string | null {
	for (const [name, value] of params) {
		if (name.toLowerCase() === ROOM_PARAM) return value;
	}
	return null;
}

/** Anything that looks like a URL or a path, rather than a typed code. */
const LOOKS_LIKE_LINK = new RegExp(`^\\w+://|/room/|[?&]${ROOM_PARAM}=`, 'i');
/**
 * Both shapes a link has had: the invite's query, and the room's own path -
 * which is what every invite was before the code moved into the query.
 *
 * Two patterns, tried in that order, and the path one anchored to the end of
 * the path. A single "whichever comes first" pattern read the wrong token out
 * of any address with a `/room/` ahead of the real code, which a deploy under
 * such a base path would put in every link it mints.
 */
const ROOM_IN_QUERY = new RegExp(`[?&]${ROOM_PARAM}=([^&#]*)`, 'i');
const ROOM_IN_PATH = /\/room\/([^/?#]+)\/?(?:[?#]|$)/i;

export function looksLikeLink(input: string): boolean {
	return LOOKS_LIKE_LINK.test(input.trim());
}

/**
 * Pulls the code out of an invite link.
 *
 * What the host copies is a URL, so pasting that URL into a box labelled for a
 * code is the obvious thing to do -- and running it through `normalizeRoomCode`
 * turns `.../?room=K7M4PQ` into `HTTPLR`, which is six characters of the
 * alphabet and therefore *valid*. The guest gets no error, just an empty room
 * they wait in forever. Read the link instead of mangling it.
 *
 * Only the code is taken. A link carrying `?create=1` cannot make a paster into
 * a host racing the real one for the same code.
 */
export function roomCodeFromLink(input: string): string | null {
	const link = input.trim();
	const match = ROOM_IN_QUERY.exec(link) ?? ROOM_IN_PATH.exec(link);
	if (!match) return null;
	try {
		return parseRoomCode(decodeURIComponent(match[1]));
	} catch {
		return null; // A malformed %-escape is not a code.
	}
}
