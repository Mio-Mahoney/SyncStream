/**
 * Which rungs a guest may select, as a numeric window Shaka can be told
 * (PLAN.md 4.5), decided from what the manifest offers, what this browser can
 * decode, and what the host has warm.
 *
 * Pure, so it can be exercised without a player: the same policy runs before
 * `load()` against the manifest's own representation list, and after it
 * against the variants Shaka kept. It lives apart from config.ts because
 * config.ts imports Shaka, which cannot be loaded outside a browser.
 */

import { LADDER, NATIVE_REP } from '$lib/media/types';

export type RungCandidate = {
	repId: number;
	height: number;
	/** Whether this browser can decode it. Shaka's post-load variant list is already filtered. */
	playable: boolean;
};

export type RungWindow = { minHeight: number; maxHeight: number };

/**
 * The policy.
 *
 * Shaka's restrictions are a window, so they cannot express a gap; the ladder
 * warms top-down so the warm set is always a contiguous prefix and the window
 * states it exactly (see ladder.ts warmUp). What the window could not say until
 * now is the codec-asymmetric case: a host whose native rung is HEVC and a
 * guest without an HEVC decoder. The guest's playable set is then the encoded
 * H.264 rungs alone, and while the host has only `[0]` warm, none of them is.
 * The old code cleared every restriction at that point and the guest's first
 * pick was whichever cold rung its bandwidth guess liked - 720p, usually - so
 * the first segments it ever fetched were the ones the host had not encoded,
 * and the estimator read the encoder's latency as a collapsed link.
 *
 * - Nothing known about warmth (`available` empty): no window. Restricting on
 *   no information would be a guess dressed as a rule.
 * - Some playable rung is warm: the window spans the warm, playable heights.
 * - No playable rung is warm: the smallest playable rung, alone. One cold rung
 *   has to be paid for by somebody, and the cheapest encode is the one the
 *   host finishes soonest; the restriction widens as the host warms up.
 * - Nothing playable at all: null. The load will fail on its own, with a
 *   message, and a window cannot help it.
 */
export function rungWindow(candidates: RungCandidate[], available: number[]): RungWindow | null {
	const playable = candidates.filter((c) => c.playable && c.height > 0);
	if (playable.length === 0 || available.length === 0) return null;
	const warm = playable.filter((c) => available.includes(c.repId));
	if (warm.length === playable.length) return { minHeight: 0, maxHeight: Infinity };
	if (warm.length > 0) {
		return {
			minHeight: Math.min(...warm.map((c) => c.height)),
			maxHeight: Math.max(...warm.map((c) => c.height))
		};
	}
	const smallest = Math.min(...playable.map((c) => c.height));
	return { minHeight: smallest, maxHeight: smallest };
}

/**
 * Reads our own MPD's video representations. The manifest is ours (manifest.ts
 * writes exactly this shape), so a regex over it is reading a known format,
 * not parsing XML in general. `isTypeSupported` is the same question Shaka
 * asks when it drops a variant, so this predicts its post-load list.
 */
export function manifestRungs(
	mpd: string,
	isTypeSupported: (type: string) => boolean
): RungCandidate[] {
	const out: RungCandidate[] = [];
	const videoSet = /<AdaptationSet[^>]*contentType="video"[\s\S]*?<\/AdaptationSet>/.exec(mpd);
	if (!videoSet) return out;
	const rep = /<Representation\s([^>]*)\/>/g;
	let m: RegExpExecArray | null;
	while ((m = rep.exec(videoSet[0])) !== null) {
		const attrs = m[1];
		const id = /\bid="(\d+)"/.exec(attrs)?.[1];
		const height = /\bheight="(\d+)"/.exec(attrs)?.[1];
		const codecs = /\bcodecs="([^"]+)"/.exec(attrs)?.[1];
		if (id === undefined || height === undefined || codecs === undefined) continue;
		let playable = false;
		try {
			playable = isTypeSupported(`video/mp4; codecs="${codecs}"`);
		} catch {
			playable = false;
		}
		out.push({ repId: Number(id), height: Number(height), playable });
	}
	return out;
}

/** The ladder's static heights, for a rung whose real height the manifest did not give. */
export function ladderHeight(repId: number): number | null {
	if (repId === NATIVE_REP) return null;
	return LADDER.find((r) => r.id === repId)?.height ?? null;
}
