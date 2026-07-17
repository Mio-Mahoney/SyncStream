/**
 * Binary framing for the `data` channel (PLAN.md 7, Phase 1).
 *
 * SCTP preserves message boundaries, so there is no length prefix: one send is
 * one frame. The header identifies which request a chunk belongs to and where
 * it sits in the sequence, so the receiver can reassemble without any
 * ordering assumptions beyond SCTP's own.
 *
 *   [u8  msgType]
 *   [u32 requestId]
 *   [u32 chunkIndex]
 *   [u32 totalChunks]
 *   [payload]
 */

export const HEADER_BYTES = 13;

/**
 * 64KB. Chrome tolerates 256KB but 64KB is the interop-safe number across
 * browsers and it paces better through the SCTP buffer (PLAN.md 7, Phase 1).
 */
export const CHUNK_BYTES = 64 * 1024;

/**
 * Ceiling on a single reassembled payload, and therefore on `totalChunks`.
 *
 * `totalChunks` is a u32 read straight off the wire, so without a cap a corrupt
 * or hostile frame claiming 4e9 chunks would have us allocate an array with
 * four billion slots before a single byte of payload arrives. 256MB is far
 * above any real segment (a 4s CMAF segment at native quality is single-digit
 * MB) and far below anything that threatens the memory budget.
 */
export const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_PAYLOAD_BYTES / CHUNK_BYTES);

export enum WireMsgType {
	/** Segment or init-segment payload, keyed by the reqId of a `segReq`. */
	SegData = 1
}

export type WireFrame = {
	type: WireMsgType;
	requestId: number;
	chunkIndex: number;
	totalChunks: number;
	payload: Uint8Array;
};

export function encodeFrame(
	type: WireMsgType,
	requestId: number,
	chunkIndex: number,
	totalChunks: number,
	payload: Uint8Array
): ArrayBuffer {
	const buf = new ArrayBuffer(HEADER_BYTES + payload.byteLength);
	const view = new DataView(buf);
	view.setUint8(0, type);
	view.setUint32(1, requestId);
	view.setUint32(5, chunkIndex);
	view.setUint32(9, totalChunks);
	new Uint8Array(buf, HEADER_BYTES).set(payload);
	return buf;
}

export function decodeFrame(buf: ArrayBuffer): WireFrame {
	if (buf.byteLength < HEADER_BYTES) {
		throw new Error(`wire: frame of ${buf.byteLength} bytes is shorter than the header`);
	}
	const view = new DataView(buf);
	return {
		type: view.getUint8(0),
		requestId: view.getUint32(1),
		chunkIndex: view.getUint32(5),
		totalChunks: view.getUint32(9),
		payload: new Uint8Array(buf, HEADER_BYTES)
	};
}

/** Split a payload into chunk-sized views. Zero-length payloads yield one empty chunk. */
export function chunk(payload: Uint8Array, size = CHUNK_BYTES): Uint8Array[] {
	if (payload.byteLength === 0) return [payload];
	const out: Uint8Array[] = [];
	for (let off = 0; off < payload.byteLength; off += size) {
		out.push(payload.subarray(off, Math.min(off + size, payload.byteLength)));
	}
	return out;
}

/**
 * Reassembles chunked frames per requestId. The caller is responsible for
 * dropping requests it no longer wants (`cancel`), otherwise a peer that
 * stops mid-transfer would leak its partial buffers.
 */
export class Reassembler {
	#pending = new Map<number, { chunks: (Uint8Array | undefined)[]; got: number; bytes: number }>();

	/** Returns the complete payload once the last chunk of a request lands. */
	push(frame: WireFrame): Uint8Array | null {
		const { requestId, chunkIndex, totalChunks, payload } = frame;

		if (totalChunks === 0) return null;
		if (totalChunks > MAX_CHUNKS) {
			throw new Error(`wire: ${totalChunks} chunks exceeds the ${MAX_CHUNKS} cap`);
		}
		if (chunkIndex >= totalChunks) {
			throw new Error(`wire: chunk ${chunkIndex} out of range for ${totalChunks} total`);
		}

		if (totalChunks === 1) {
			this.#pending.delete(requestId);
			// Copy: the payload is a view onto the received buffer, which we do
			// not want to retain beyond this call.
			return new Uint8Array(payload);
		}

		let entry = this.#pending.get(requestId);
		if (!entry) {
			entry = { chunks: new Array(totalChunks), got: 0, bytes: 0 };
			this.#pending.set(requestId, entry);
		}
		if (entry.chunks[chunkIndex]) return null; // duplicate

		entry.chunks[chunkIndex] = new Uint8Array(payload);
		entry.got++;
		entry.bytes += payload.byteLength;

		if (entry.got < totalChunks) return null;

		const out = new Uint8Array(entry.bytes);
		let off = 0;
		for (const c of entry.chunks) {
			out.set(c!, off);
			off += c!.byteLength;
		}
		this.#pending.delete(requestId);
		return out;
	}

	cancel(requestId: number): void {
		this.#pending.delete(requestId);
	}

	clear(): void {
		this.#pending.clear();
	}

	/** Bytes currently held in partial reassembly, for the stats overlay. */
	get pendingBytes(): number {
		let n = 0;
		for (const e of this.#pending.values()) n += e.bytes;
		return n;
	}
}
