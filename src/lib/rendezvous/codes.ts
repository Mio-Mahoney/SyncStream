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

/**
 * The room's key, which only the invite link carries.
 *
 * The code is the room's *name*: it is what the relays see (hashed, but a
 * six-character code is thirty bits, and an observer holding the relay traffic
 * recovers it offline in minutes), it is what is printed on screen, and it is
 * all a stranger needs to find the room. It was the only credential, and that
 * was fine for development. The key is what joining actually takes: it is the
 * password the rendezvous layer encrypts every offer and answer with, so a
 * peer holding the code alone can see that a room exists and cannot say a
 * word to anyone in it. Sixteen characters of the same alphabet is eighty
 * bits, well past brute force, and short enough to survive a chat client.
 *
 * It rides in the link's fragment (`#k=...`), which browsers never send in an
 * HTTP request: the static host serving this page does not get a copy of it
 * in its logs, and neither does anything the page fetches. Page JavaScript
 * can read it, which is the point.
 */
export const SECRET_LENGTH = 16;

/** The fragment parameter the key travels under. */
export const KEY_PARAM = 'k';

const BITS_PER_CHAR = 5; // 2^5 === CODE_ALPHABET.length

function randomString(length: number): string {
	if (CODE_ALPHABET.length !== 1 << BITS_PER_CHAR) {
		throw new Error('codes: alphabet must be exactly 32 characters for unbiased sampling');
	}
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let out = '';
	for (const b of bytes) {
		out += CODE_ALPHABET[b & ((1 << BITS_PER_CHAR) - 1)];
	}
	return out;
}

export function generateRoomCode(): string {
	return randomString(CODE_LENGTH);
}

export function generateRoomSecret(): string {
	return randomString(SECRET_LENGTH);
}

function inAlphabet(s: string, length: number): boolean {
	if (s.length !== length) return false;
	for (const ch of s) {
		if (!CODE_ALPHABET.includes(ch)) return false;
	}
	return true;
}

export function isValidRoomCode(code: string): boolean {
	return inAlphabet(code, CODE_LENGTH);
}

export function isValidRoomSecret(secret: string): boolean {
	return inAlphabet(secret, SECRET_LENGTH);
}

/** The fragment a room URL carries its key in. */
export function roomHash(secret: string): string {
	return `#${KEY_PARAM}=${secret}`;
}

/**
 * The key out of a URL fragment, or null when there is no valid one. Reads the
 * fragment as query-style parameters, so a second parameter can join it later
 * without a format change.
 */
export function secretFromHash(hash: string): string | null {
	const raw = hash.startsWith('#') ? hash.slice(1) : hash;
	if (!raw) return null;
	const secret = new URLSearchParams(raw).get(KEY_PARAM);
	return secret !== null && isValidRoomSecret(secret) ? secret : null;
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

export type RoomRef = { code: string; secret: string };

/**
 * Pulls the room out of an invite link: its code from the path and its key
 * from the fragment.
 *
 * What the host copies is a URL, so pasting that URL into the join box is the
 * obvious thing to do -- and running it through `normalizeRoomCode` turns
 * `.../room/K7M4PQ` into `HTTPLC`, which is six characters of the alphabet and
 * therefore *valid*. The guest gets no error, just an empty room they wait in
 * forever. Read the link instead of mangling it.
 *
 * Only the code and key are taken. A link carrying `?create=1` cannot make a
 * paster into a host racing the real one for the same code. A link without a
 * key names a room nobody can join, and returns null like any other broken
 * link: the landing page says so, rather than sending the guest to wait.
 */
export function roomFromLink(input: string): RoomRef | null {
	const trimmed = input.trim();
	const match = ROOM_PATH.exec(trimmed);
	if (!match) return null;
	let path: string;
	try {
		path = decodeURIComponent(match[1]);
	} catch {
		return null; // A malformed %-escape is not a code.
	}
	const code = normalizeRoomCode(path);
	if (!isValidRoomCode(code) || code.length !== path.length) return null;
	const hashAt = trimmed.indexOf('#');
	const secret = hashAt === -1 ? null : secretFromHash(trimmed.slice(hashAt));
	return secret ? { code, secret } : null;
}

/** Whether a pasted link names a room but has lost its key - a different message from "not a link". */
export function linkLacksKey(input: string): boolean {
	const trimmed = input.trim();
	const match = ROOM_PATH.exec(trimmed);
	if (!match) return false;
	const hashAt = trimmed.indexOf('#');
	return hashAt === -1 || secretFromHash(trimmed.slice(hashAt)) === null;
}
