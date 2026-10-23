import { describe, expect, test } from 'bun:test';
import {
	CHUNK_BYTES,
	HEADER_BYTES,
	MAX_PENDING_BYTES,
	MAX_PENDING_REQUESTS,
	Reassembler,
	WireMsgType,
	chunk,
	decodeFrame,
	encodeFrame
} from '$lib/protocol/wire';

const frame = (reqId: number, idx: number, total: number, bytes: number) =>
	decodeFrame(encodeFrame(WireMsgType.SegData, reqId, idx, total, new Uint8Array(bytes).fill(7)));

describe('framing', () => {
	test('a frame round-trips its header and payload', () => {
		const payload = new Uint8Array([1, 2, 3]);
		const f = decodeFrame(encodeFrame(WireMsgType.SegData, 42, 1, 2, payload));
		expect(f).toMatchObject({
			type: WireMsgType.SegData,
			requestId: 42,
			chunkIndex: 1,
			totalChunks: 2
		});
		expect([...f.payload]).toEqual([1, 2, 3]);
	});

	test('a frame shorter than the header is refused', () => {
		expect(() => decodeFrame(new ArrayBuffer(HEADER_BYTES - 1))).toThrow(/shorter than the header/);
	});

	test('chunking covers the payload exactly and an empty payload is one empty chunk', () => {
		const parts = chunk(new Uint8Array(CHUNK_BYTES * 2 + 1));
		expect(parts.map((p) => p.byteLength)).toEqual([CHUNK_BYTES, CHUNK_BYTES, 1]);
		expect(chunk(new Uint8Array(0)).length).toBe(1);
	});
});

describe('Reassembler', () => {
	test('reassembles chunks in any order and frees the entry', () => {
		const r = new Reassembler();
		expect(r.push(frame(1, 1, 3, 10))).toBeNull();
		expect(r.push(frame(1, 0, 3, 10))).toBeNull();
		expect(r.pendingBytes).toBe(20);
		const out = r.push(frame(1, 2, 3, 5));
		expect(out?.byteLength).toBe(25);
		expect(r.pendingBytes).toBe(0);
		expect(r.pendingCount).toBe(0);
	});

	test('a duplicate chunk is ignored rather than counted twice', () => {
		const r = new Reassembler();
		r.push(frame(1, 0, 2, 4));
		r.push(frame(1, 0, 2, 4));
		expect(r.pendingBytes).toBe(4);
		expect(r.push(frame(1, 1, 2, 4))?.byteLength).toBe(8);
	});

	test('REVIEW F-03: partial transfers under fresh ids cannot grow without bound', () => {
		const r = new Reassembler();
		for (let id = 0; id < 10_000; id++) r.push(frame(id, 0, 2, 1024));
		expect(r.pendingCount).toBeLessThanOrEqual(MAX_PENDING_REQUESTS);
		expect(r.pendingBytes).toBeLessThanOrEqual(MAX_PENDING_REQUESTS * 1024);
	});

	test('REVIEW F-03: pending bytes are capped even across few requests', () => {
		const r = new Reassembler(1000, 4 * CHUNK_BYTES);
		// Two requests each holding three full chunks of a four-chunk transfer.
		for (let i = 0; i < 3; i++) r.push(frame(1, i, 4, CHUNK_BYTES));
		for (let i = 0; i < 3; i++) r.push(frame(2, i, 4, CHUNK_BYTES));
		expect(r.pendingBytes).toBeLessThanOrEqual(4 * CHUNK_BYTES);
		// The newest request survived; the oldest paid.
		expect(r.pendingCount).toBe(1);
		expect(r.push(frame(2, 3, 4, CHUNK_BYTES))?.byteLength).toBe(4 * CHUNK_BYTES);
	});

	test('REVIEW F-03: a frame claiming many chunks while sending none costs nothing', () => {
		const r = new Reassembler();
		// 4096 claimed chunks is past the payload cap and refused outright; 1000
		// is inside it, and each such frame used to allocate a 1000-slot array
		// that nothing ever freed.
		expect(() => r.push(frame(0, 0, 4096, 0))).toThrow(/exceeds/);
		for (let id = 0; id < 50_000; id++) r.push(frame(id, 0, 1000, 0));
		expect(r.pendingCount).toBeLessThanOrEqual(MAX_PENDING_REQUESTS);
		expect(r.pendingBytes).toBe(0);
	});

	test('a chunk larger than CHUNK_BYTES is refused and drops its request', () => {
		const r = new Reassembler();
		r.push(frame(7, 0, 3, 10));
		expect(() => r.push(frame(7, 1, 3, CHUNK_BYTES + 1))).toThrow(/exceeds/);
		expect(r.pendingCount).toBe(0);
	});

	test('a frame that disagrees about totalChunks drops the request instead of leaking it', () => {
		const r = new Reassembler();
		r.push(frame(9, 0, 3, 10));
		expect(() => r.push(frame(9, 1, 5, 10))).toThrow(/changed from 3 to 5/);
		expect(r.pendingCount).toBe(0);
		expect(r.pendingBytes).toBe(0);
	});

	test('cancel releases a partial, and the caps are sane relative to each other', () => {
		const r = new Reassembler();
		r.push(frame(3, 0, 2, 100));
		r.cancel(3);
		expect(r.pendingBytes).toBe(0);
		expect(MAX_PENDING_BYTES).toBeGreaterThan(CHUNK_BYTES * 16);
	});
});
