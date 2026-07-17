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

/** Anything that looks like a URL or a path, rather than a typed code. */
const LOOKS_LIKE_LINK = /^\w+:\/\/|\/room\//i;
const ROOM_PATH = /\/room\/([^/?#]+)/i;

export function looksLikeLink(input: string): boolean {
	return LOOKS_LIKE_LINK.test(input.trim());
}

/**
 * Pulls the code out of an invite link.
 *
 * What the host copies is a URL, so pasting that URL into a box labelled for a
 * code is the obvious thing to do -- and running it through `normalizeRoomCode`
 * turns `.../room/K7M4PQ` into `HTTPLC`, which is six characters of the
 * alphabet and therefore *valid*. The guest gets no error, just an empty room
 * they wait in forever. Read the link instead of mangling it.
 *
 * Only the code is taken. A link carrying `?create=1` cannot make a paster into
 * a host racing the real one for the same code.
 */
export function roomCodeFromLink(input: string): string | null {
	const match = ROOM_PATH.exec(input.trim());
	if (!match) return null;
	let path: string;
	try {
		path = decodeURIComponent(match[1]);
	} catch {
		return null; // A malformed %-escape is not a code.
	}
	const code = normalizeRoomCode(path);
	return isValidRoomCode(code) && code.length === path.length ? code : null;
}
