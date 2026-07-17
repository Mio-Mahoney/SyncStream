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
