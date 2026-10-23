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
 * four billion slots before a single byte of payload arrives. 64MB is far
 * above any real segment (a 4s CMAF segment at native quality is single-digit
 * MB; a 4K Blu-ray remux's is ~25MB) and far below anything that threatens the
 * memory budget.
 */
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_PAYLOAD_BYTES / CHUNK_BYTES);

/**
 * How many requests one link may have in partial reassembly at once, and how
 * many bytes they may hold between them.
 *
 * Admission (see `attachChannels`) already refuses frames for requests nobody
 * on this side asked for, so these bound what an *asked-for* transfer can
 * cost: a peer answering a real request could still send chunk 0 of a 2-chunk
 * reply and stop, forever, under every reqId we ever hand it. A legitimate
 * requester has at most a handful in flight (Shaka's parallelism plus one
 * prefetch), so the caps are generous for the honest case and small against
 * the budget. Past either, the oldest partial is dropped; its requester's own
 * deadline turns that into a retry.
 */
export const MAX_PENDING_REQUESTS = 32;
export const MAX_PENDING_BYTES = 2 * MAX_PAYLOAD_BYTES;

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

type Partial = {
	chunks: (Uint8Array | undefined)[];
	/** The totalChunks the first frame declared. Every later frame must agree. */
	total: number;
	got: number;
	bytes: number;
};

/**
 * Reassembles chunked frames per requestId. The caller is responsible for
 * dropping requests it no longer wants (`cancel`), otherwise a peer that
 * stops mid-transfer would leak its partial buffers - and for the caller
 * forgetting, the caps above are the backstop.
 *
 * Every check here is against a frame a remote peer composed. A frame that
 * disagrees with itself or with the entry it joins throws, and the caller
 * drops the whole request: a transfer whose chunks do not add up cannot be
 * made to, and keeping its partial around is what the caps exist to prevent.
 */
export class Reassembler {
	#pending = new Map<number, Partial>();
	#bytes = 0;
	readonly #maxRequests: number;
	readonly #maxBytes: number;

	constructor(maxRequests = MAX_PENDING_REQUESTS, maxBytes = MAX_PENDING_BYTES) {
		this.#maxRequests = maxRequests;
		this.#maxBytes = maxBytes;
	}

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
		// The sender cuts at CHUNK_BYTES, so a bigger chunk is not ours. Without
		// this the chunk-count cap bounds nothing: one chunk may be any size.
		if (payload.byteLength > CHUNK_BYTES) {
			this.cancel(requestId);
			throw new Error(`wire: chunk of ${payload.byteLength} bytes exceeds ${CHUNK_BYTES}`);
		}

		if (totalChunks === 1) {
			this.cancel(requestId);
			// Copy: the payload is a view onto the received buffer, which we do
			// not want to retain beyond this call.
			return new Uint8Array(payload);
		}

		let entry = this.#pending.get(requestId);
		if (!entry) {
			this.#makeRoom();
			entry = { chunks: new Array(totalChunks), total: totalChunks, got: 0, bytes: 0 };
			this.#pending.set(requestId, entry);
		} else if (entry.total !== totalChunks) {
			// A frame that disagrees with the first about how many are coming
			// cannot be fitted into the same transfer. Drop the lot rather than
			// leave an entry that can never complete.
			this.cancel(requestId);
			throw new Error(
				`wire: request ${requestId} changed from ${entry.total} to ${totalChunks} chunks`
			);
		}
		if (entry.chunks[chunkIndex]) return null; // duplicate

		entry.chunks[chunkIndex] = new Uint8Array(payload);
		entry.got++;
		entry.bytes += payload.byteLength;
		this.#bytes += payload.byteLength;
		if (this.#bytes > this.#maxBytes) this.#makeRoom(requestId);

		if (entry.got < totalChunks) return null;

		const out = new Uint8Array(entry.bytes);
		let off = 0;
		for (const c of entry.chunks) {
			out.set(c!, off);
			off += c!.byteLength;
		}
		this.cancel(requestId);
		return out;
	}

	/**
	 * Evicts oldest-first until both caps hold, sparing `keep` (the request a
	 * frame is being added to right now, which is the newest and the one most
	 * likely to complete).
	 */
	#makeRoom(keep?: number): void {
		for (const [id] of this.#pending) {
			if (this.#pending.size < this.#maxRequests && this.#bytes <= this.#maxBytes) return;
			if (id === keep) continue;
			this.cancel(id);
		}
	}

	cancel(requestId: number): void {
		const entry = this.#pending.get(requestId);
		if (!entry) return;
		this.#pending.delete(requestId);
		this.#bytes -= entry.bytes;
	}

	clear(): void {
		this.#pending.clear();
		this.#bytes = 0;
	}

	/** Requests in partial reassembly. */
	get pendingCount(): number {
		return this.#pending.size;
	}

	/** Bytes currently held in partial reassembly, for the stats overlay. */
	get pendingBytes(): number {
		return this.#bytes;
	}
}
