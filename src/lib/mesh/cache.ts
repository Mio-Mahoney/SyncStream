/**
 * What a guest keeps around to serve others (PLAN.md 7, Phase 5), and the one
 * honesty check on what a peer hands back.
 */

/**
 * Sized off the sync engine rather than off the file: Phase 3 holds every
 * playhead within ~100ms of the host's and the readiness barrier stops the room
 * when one guest falls behind, so the segments a peer can plausibly want are the
 * ones from the last few seconds. 64MB is ~60s of 8 Mbps native video, which is
 * an order of magnitude more window than the room can actually spread across,
 * and it is paid on top of Shaka's own buffer inside the Phase 2 memory budget.
 */
export const MESH_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * A byte cap alone would let thousands of small segments in, and every cached
 * key is a key in every `have` we send. This bounds the announce.
 */
export const MESH_CACHE_KEYS = 512;

/**
 * A cheap honesty check on what a peer handed us.
 *
 * We cannot verify the *content* of a segment: the key is content-addressing by
 * convention, not by digest, and neither segReq/segData nor the frame header
 * carries a hash to check against. So this catches the failures that are
 * detectable -- an empty body, a truncated transfer, HTML, a peer answering with
 * something that is not a fragment at all. A well-formed fragment for the wrong
 * segment is the one this cannot catch, which is why every request and
 * announcement is stamped with the film it belongs to (`Ready.film`): the way a
 * wrong-but-well-formed fragment actually arose was the host changing films.
 */
const FRAGMENT_BOXES = new Set(['moof', 'styp', 'sidx', 'emsg']);

export function looksLikeFragment(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 8) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const size = view.getUint32(0);
	// size 1 defers to a 64-bit largesize; 0 means "to the end". Anything else
	// must describe a box that fits in what we received.
	if (size !== 0 && size !== 1 && (size < 8 || size > bytes.byteLength)) return false;
	let type = '';
	for (let i = 4; i < 8; i++) type += String.fromCharCode(bytes[i]);
	return FRAGMENT_BOXES.has(type);
}

/** Byte- and count-capped LRU. `onChange` fires only when the key SET moves. */
export class SegmentCache {
	readonly #map = new Map<string, Uint8Array>();
	readonly #cap: number;
	readonly #maxKeys: number;
	readonly #onChange: () => void;
	#bytes = 0;

	constructor(cap: number, maxKeys: number, onChange: () => void) {
		this.#cap = cap;
		this.#maxKeys = maxKeys;
		this.#onChange = onChange;
	}

	get(key: string): Uint8Array | undefined {
		const val = this.#map.get(key);
		if (!val) return undefined;
		// Re-insert: Map iterates in insertion order, so this is the recency list.
		// A segment a peer asked us for is a segment worth keeping.
		this.#map.delete(key);
		this.#map.set(key, val);
		return val;
	}

	has(key: string): boolean {
		return this.#map.has(key);
	}

	put(key: string, val: Uint8Array): void {
		// One segment larger than the whole cap would evict everything and then sit
		// there alone. Sparse-keyframe files produce them.
		if (val.byteLength > this.#cap) return;
		const prev = this.#map.get(key);
		if (prev) {
			this.#bytes -= prev.byteLength;
			this.#map.delete(key);
		}
		this.#map.set(key, val);
		this.#bytes += val.byteLength;
		let changed = prev === undefined;
		while (this.#bytes > this.#cap || this.#map.size > this.#maxKeys) {
			const oldest = this.#map.keys().next();
			if (oldest.done || oldest.value === key) break;
			const evicted = this.#map.get(oldest.value);
			this.#map.delete(oldest.value);
			if (evicted) this.#bytes -= evicted.byteLength;
			changed = true;
		}
		if (changed) this.#onChange();
	}

	keys(): string[] {
		return [...this.#map.keys()];
	}

	get size(): number {
		return this.#map.size;
	}

	get bytes(): number {
		return this.#bytes;
	}

	clear(): void {
		this.#map.clear();
		this.#bytes = 0;
	}
}
