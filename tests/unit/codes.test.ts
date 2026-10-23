import { describe, expect, test } from 'bun:test';
import {
	CODE_LENGTH,
	SECRET_LENGTH,
	generateRoomCode,
	generateRoomSecret,
	isValidRoomCode,
	isValidRoomSecret,
	linkLacksKey,
	normalizeRoomCode,
	roomFromLink,
	roomHash,
	secretFromHash
} from '$lib/rendezvous/codes';

describe('room codes and keys', () => {
	test('generated values are the right length and alphabet', () => {
		for (let i = 0; i < 50; i++) {
			expect(isValidRoomCode(generateRoomCode())).toBe(true);
			expect(isValidRoomSecret(generateRoomSecret())).toBe(true);
		}
		expect(generateRoomCode()).toHaveLength(CODE_LENGTH);
		expect(generateRoomSecret()).toHaveLength(SECRET_LENGTH);
	});

	test('the key is at least eighty bits', () => {
		expect(SECRET_LENGTH * 5).toBeGreaterThanOrEqual(80);
	});

	test('ambiguous characters are dropped, not remapped', () => {
		expect(normalizeRoomCode('k7 m4-pq')).toBe('K7M4PQ');
		expect(normalizeRoomCode('O0I1ABCDEF')).toBe('ABCDEF');
	});

	test('the fragment round-trips the key and rejects junk', () => {
		const secret = generateRoomSecret();
		expect(secretFromHash(roomHash(secret))).toBe(secret);
		expect(secretFromHash('#k=short')).toBeNull();
		expect(secretFromHash('')).toBeNull();
		expect(secretFromHash('#other=1')).toBeNull();
	});

	test('a full invite link yields the room; a link without a key does not', () => {
		const secret = generateRoomSecret();
		const link = `https://host.example/SyncStream/room/K7M4PQ?s=nostr#k=${secret}`;
		expect(roomFromLink(link)).toEqual({ code: 'K7M4PQ', secret });
		expect(roomFromLink(` ${link} `)).toEqual({ code: 'K7M4PQ', secret });
		expect(roomFromLink('https://host.example/room/K7M4PQ?s=nostr')).toBeNull();
		expect(linkLacksKey('https://host.example/room/K7M4PQ?s=nostr')).toBe(true);
		expect(linkLacksKey('https://host.example/watch')).toBe(false);
	});

	test('a link whose path is not a code is not salvaged into one', () => {
		expect(roomFromLink('https://x/room/K7M4PQX#k=' + generateRoomSecret())).toBeNull();
		expect(roomFromLink('https://x/room/%ZZ#k=' + generateRoomSecret())).toBeNull();
	});
});
