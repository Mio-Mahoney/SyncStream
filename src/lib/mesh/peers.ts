/**
 * The guest's side of choosing a peer (PLAN.md 7, Phase 5): what the tracker
 * said about who holds a key, and what we have measured about each of them.
 */

import type { PeerLink, PeerNetwork } from '$lib/rtc/connection';

/** How long a tracker answer is worth acting on before we ask again. */
export const SOURCE_TTL_MS = 15_000;

/**
 * How long "nobody has this" is worth believing. Much shorter than
 * SOURCE_TTL_MS, and the difference is load-bearing for the prefetcher: an
 * owner fills its stripe just ahead of the room's aligned fetches, so a
 * segment's holder routinely appears BETWEEN our last ask and our fetch. Under
 * one shared TTL the empty answer blinds us for 15s and every fetch the
 * prefetcher set up for a peer lands on the host anyway. Re-asking empties
 * every few seconds keeps the last ask inside the announce-to-fetch gap;
 * non-empty answers keep the long TTL, since a claim only goes bad by
 * eviction, which PeerMiss already handles.
 */
export const EMPTY_SOURCE_TTL_MS = 4000;

/** Tracker answers we retain. Well past the lookahead window at any bitrate. */
const SOURCE_TABLE_MAX = 4096;

/** Requests we will stack on one peer before preferring someone else. */
export const MAX_OUTSTANDING_PER_PEER = 3;

/** Below this a peer is not worth the round trip, and the host takes it. */
export const MIN_PEER_BPS = 250_000;

/**
 * What we credit a peer that has never delivered to us. A pure measurement reads
 * zero for an unproven peer, would never pick it, and the mesh would never
 * bootstrap. This is the guess that buys the sample which replaces it.
 */
export const OPTIMISTIC_BPS = 2_000_000;

/** Backoff for a peer that timed out or lied, doubling per strike. */
const PENALTY_BASE_MS = 5000;
const PENALTY_MAX_MS = 60_000;

const RATE_ALPHA = 0.3;

type SourceEntry = { peers: string[]; at: number };
type Penalty = { strikes: number; until: number };

/** What the tracker told us: key -> peers that claimed it, with the time we heard it. */
export class SourceTable {
	readonly #table = new Map<string, SourceEntry>();

	/** The claimants for `key`, dropping the entry if it has aged out. */
	get(key: string, now: number): string[] | null {
		const entry = this.#table.get(key);
		if (!entry) return null;
		if (now - entry.at > SOURCE_TTL_MS) {
			this.#table.delete(key);
			return null;
		}
		return entry.peers;
	}

	/**
	 * Whether `key` is worth asking the tracker about again. An empty answer
	 * goes stale on its own, shorter clock (see EMPTY_SOURCE_TTL_MS).
	 */
	wantsAsk(key: string, now: number): boolean {
		const entry = this.#table.get(key);
		if (!entry) return true;
		const ttl = entry.peers.length > 0 ? SOURCE_TTL_MS : EMPTY_SOURCE_TTL_MS;
		return now - entry.at >= ttl;
	}

	remember(key: string, peers: string[], now: number): void {
		this.#table.set(key, { peers, at: now });
		while (this.#table.size > SOURCE_TABLE_MAX) {
			const oldest = this.#table.keys().next();
			if (oldest.done || oldest.value === key) break;
			this.#table.delete(oldest.value);
		}
	}

	/** Retracts one peer's claim on one key without touching the rest of the answer. */
	drop(key: string, peerId: string): void {
		const entry = this.#table.get(key);
		if (!entry) return;
		entry.peers = entry.peers.filter((id) => id !== peerId);
	}

	clear(): void {
		this.#table.clear();
	}
}

/** Our own measurement of each peer, and our opinion of it. */
export class PeerScores {
	/** Throughput per peer, in bits/sec, EWMA over completed fetches. */
	readonly #rates = new Map<string, number>();
	readonly #penalties = new Map<string, Penalty>();

	rateOf(link: PeerLink): number {
		const measured = this.#rates.get(link.peerId);
		if (measured === undefined) return OPTIMISTIC_BPS;
		// stats.throughputBps is a 2s window, so it reads zero on an idle link and
		// a peer that served us well would never be picked again. Live traffic can
		// raise the estimate; it never lowers it below what the peer has delivered.
		//
		// ChannelStats.throughputBps is BYTES per second (channel.ts sums received
		// byte counts; stats.svelte.ts documents it as bytes/sec). Everything on
		// this side of the module -- `rates`, MIN_PEER_BPS, OPTIMISTIC_BPS -- is
		// bits per second. Convert, or the comparison understates a live peer by
		// 8x and benches peers that are comfortably fast enough.
		return Math.max(measured, link.channels.stats.throughputBps * 8);
	}

	recordRate(peerId: string, bytes: number, elapsedMs: number): void {
		const bps = (bytes * 8 * 1000) / Math.max(elapsedMs, 1);
		const prev = this.#rates.get(peerId);
		this.#rates.set(peerId, prev === undefined ? bps : prev * (1 - RATE_ALPHA) + bps * RATE_ALPHA);
	}

	reward(peerId: string): void {
		const p = this.#penalties.get(peerId);
		if (!p) return;
		p.strikes -= 1;
		p.until = 0;
		if (p.strikes <= 0) this.#penalties.delete(peerId);
	}

	penalise(peerId: string, now: number): void {
		const p = this.#penalties.get(peerId) ?? { strikes: 0, until: 0 };
		p.strikes = Math.min(p.strikes + 1, 8);
		p.until = now + Math.min(PENALTY_BASE_MS * 2 ** (p.strikes - 1), PENALTY_MAX_MS);
		this.#penalties.set(peerId, p);
	}

	benched(peerId: string, now: number): boolean {
		const penalty = this.#penalties.get(peerId);
		return penalty !== undefined && now < penalty.until;
	}

	forget(peerId: string): void {
		this.#rates.delete(peerId);
		this.#penalties.delete(peerId);
	}

	clear(): void {
		this.#rates.clear();
		this.#penalties.clear();
	}

	/**
	 * The best of `peers` for a fetch, or null for "ask the host".
	 *
	 * Best throughput and fewest outstanding requests (PLAN.md 7, Phase 5). The
	 * divisor is not a fairness knob: a peer already carrying our requests will
	 * queue this one behind them on its single ordered channel, so its effective
	 * rate for us really is divided.
	 */
	pick(
		peers: readonly string[],
		network: PeerNetwork,
		hostPeerId: string | null,
		outstanding: (peerId: string) => number,
		now: number
	): PeerLink | null {
		let best: PeerLink | null = null;
		let bestScore = 0;
		for (const peerId of peers) {
			if (peerId === hostPeerId) continue; // the host is the fallback, not a mesh peer
			const link = network.get(peerId);
			if (!link) continue;
			if (this.benched(peerId, now)) continue;
			const out = outstanding(peerId);
			if (out >= MAX_OUTSTANDING_PER_PEER) continue;
			const rate = this.rateOf(link);
			if (rate < MIN_PEER_BPS) continue;
			const score = rate / (1 + out);
			if (score > bestScore) {
				bestScore = score;
				best = link;
			}
		}
		return best;
	}
}
