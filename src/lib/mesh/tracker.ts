/**
 * The host's side of the mesh (PLAN.md 7, Phase 5): who holds what.
 *
 * Guests announce their caches; the tracker answers "who has key K" with the
 * peers that said so and are still connected. Every claim is scoped to the
 * film it was made about (`Ready.film`): a segment key names different bytes
 * under each film the host puts on, and a claim about the previous film's
 * bytes, honoured after a switch, pointed guests at the wrong picture and had
 * them cache it (REVIEW F-04).
 */

import { parseSegKey } from '$lib/protocol/control';

/** Bound on an untrusted peer's `have` and on a `sourcesReq` we will answer. */
export const HAVE_MAX_KEYS = 1024;

export class Tracker {
	/** Both directions, so a peer leaving is a cheap removal. */
	readonly #byKey = new Map<string, Set<string>>();
	readonly #byPeer = new Map<string, Set<string>>();
	#film: string;

	constructor(film: string) {
		this.#film = film;
	}

	/**
	 * A new film is on. Every claim named the old film's bytes under keys the
	 * new film reuses, so all of them go, and from here only announcements and
	 * queries stamped with `film` are honoured.
	 */
	setFilm(film: string): void {
		if (film === this.#film) return;
		this.#film = film;
		this.#byKey.clear();
		this.#byPeer.clear();
	}

	/**
	 * `keys` is peerId's complete cache, not a delta: what is absent has been
	 * evicted (see mesh.ts flushAnnounce). Off a peer's control channel, so
	 * typed but unchecked - a guest sending nonsense is a guest to ignore, not
	 * an exception to throw through the room's dispatcher.
	 */
	handleHave(peerId: string, film: string, keys: unknown): void {
		if (!Array.isArray(keys)) return;
		// A cache of the previous film, announced by a guest that has not yet
		// rebuilt around this one. Its keys collide with this film's; pointing
		// anyone at them would serve the wrong picture.
		if (film !== this.#film) return;
		const next = new Set<string>();
		for (const key of keys) {
			if (next.size >= HAVE_MAX_KEYS) break; // a peer is untrusted; its `have` is not a memory budget
			if (typeof key === 'string' && parseSegKey(key)) next.add(key);
		}

		const prev = this.#byPeer.get(peerId);
		if (prev) {
			for (const key of prev) {
				if (next.has(key)) continue;
				this.#unclaim(key, peerId);
			}
		}
		for (const key of next) {
			let set = this.#byKey.get(key);
			if (!set) {
				set = new Set();
				this.#byKey.set(key, set);
			}
			set.add(peerId);
		}
		if (next.size === 0) this.#byPeer.delete(peerId);
		else this.#byPeer.set(peerId, next);
	}

	/**
	 * Who holds each of `keys`, among peers `isLive` still vouches for. A stale
	 * name here is a round trip the asker spends on nobody.
	 */
	sources(
		film: string,
		keys: unknown,
		isLive: (peerId: string) => boolean
	): Record<string, string[]> {
		const out: Record<string, string[]> = {};
		if (film !== this.#film || !Array.isArray(keys)) return out;
		for (const key of keys.slice(0, HAVE_MAX_KEYS)) {
			if (typeof key !== 'string') continue;
			const set = this.#byKey.get(key);
			if (!set || set.size === 0) continue;
			const live = [...set].filter(isLive);
			if (live.length > 0) out[key] = live;
		}
		return out;
	}

	/** A peer that left holds nothing. */
	forget(peerId: string): void {
		const keys = this.#byPeer.get(peerId);
		if (!keys) return;
		for (const key of keys) this.#unclaim(key, peerId);
		this.#byPeer.delete(peerId);
	}

	clear(): void {
		this.#byKey.clear();
		this.#byPeer.clear();
	}

	#unclaim(key: string, peerId: string): void {
		const set = this.#byKey.get(key);
		if (!set) return;
		set.delete(peerId);
		if (set.size === 0) this.#byKey.delete(key);
	}
}
