/**
 * Shaka, configured (PLAN.md 4.2, Phase 4).
 *
 * Everything here is configuration or a read of Shaka's own state. There is no
 * buffer manager and no ABR controller in this file, and adding one would undo
 * the largest tech-debt reduction in the plan. In particular the estimator is
 * left strictly alone: it already implements the conservative dual-EWMA logic
 * and switching hysteresis we would otherwise write, get subtly wrong, and
 * maintain forever.
 */

import shaka from 'shaka-player/dist/shaka-player.compiled.js';
import { manifestRungs, rungWindow, type RungCandidate } from '$lib/media/shaka/rungs';

/**
 * A watch party is VOD over one host uplink, so we buffer far more aggressively
 * than a live stream would. Deep buffer is also what gives the Phase 3
 * readiness barrier room to act before a guest actually stalls.
 */
const BUFFERING_GOAL_SEC = 30;
const BUFFER_BEHIND_SEC = 30;

/**
 * Explicit rather than derived from the MPD's minBufferTime: the barrier's
 * thresholds (pause under 1s, resume over 5s) are calibrated against this, and
 * they must not silently move when manifest.ts picks a different minBufferTime.
 */
const REBUFFERING_GOAL_SEC = 2;

/** A gap this small is float noise around a range edge, not a real stall. */
const RANGE_EPSILON_SEC = 0.1;

export async function createPlayer(video: HTMLMediaElement): Promise<shaka.Player> {
	// Must precede construction. Also the ManagedMediaSource path iOS guests
	// take (PLAN.md 4.8), which is Shaka's to handle and ours to leave enabled.
	shaka.polyfill.installAll();
	if (!shaka.Player.isBrowserSupported()) {
		throw new Error('This browser cannot play video: Media Source Extensions are unavailable.');
	}
	// Attach separately rather than passing the element to the constructor: the
	// constructor form is deprecated and swallows attach failures.
	const player = new shaka.Player();
	try {
		await player.attach(video);
	} catch (e) {
		// The constructor already registered a global `online` listener and timers
		// that only destroy() releases. Surfacing the attach failure is the whole
		// reason we do not use the constructor form, so it must not also strand a
		// Player the caller never got a reference to and therefore cannot clean up.
		// destroy() failing is not allowed to mask why we are here.
		await player.destroy().catch(() => {});
		throw e;
	}
	return player;
}

export function configurePlayer(
	player: shaka.Player,
	opts: {
		bandwidthEstimate?: number;
		availableRungs?: number[];
		/**
		 * The manifest about to be loaded. With it the rung window is decided
		 * from the manifest's own representation list before `load()`, which is
		 * the only way to steer the FIRST variant Shaka picks; after load the
		 * loaded variants are read instead.
		 */
		mpd?: string;
	}
): void {
	player.configure({
		streaming: {
			bufferingGoal: BUFFERING_GOAL_SEC,
			rebufferingGoal: REBUFFERING_GOAL_SEC,
			bufferBehind: BUFFER_BEHIND_SEC
			// Gap jumping and stall detection stay at their defaults on purpose.
			// They are the browser quirk table we adopted Shaka to avoid owning.
		},
		/**
		 * Left at Shaka's defaults, deliberately, including `cacheLoadThreshold`
		 * and the estimator half-lives.
		 *
		 * A previous pass lowered `cacheLoadThreshold` to 0 to "let mesh
		 * deliveries count". That was a misreading worth recording so it is not
		 * repeated: the default is 5ms, and a real peer-served segment is
		 * megabytes over a data channel, which takes tens to hundreds of
		 * milliseconds and was never being discarded. The only things under the
		 * threshold are the mesh's own LOCAL cache hits -- which the Phase 5
		 * prefetcher makes common by design, and which are not bandwidth evidence
		 * at all. Counting them injects samples of `8000 * bytes / ~2ms`, i.e.
		 * tens of Gbps, and at a shortened half-life one such sample can move a
		 * guest's estimate by ~28 Mbps on its own. The estimator would then be
		 * promising a capacity nothing measured, which under the readiness
		 * barrier is one guest's overshoot becoming the whole room's stall.
		 *
		 * Mesh deliveries reach the estimator the honest way instead: a live
		 * fetch served by a peer IS a real transfer through the scheme handler
		 * and is sampled like any other. Only the prefetcher's own transfers are
		 * invisible to Shaka, and the answer to that is to show it those
		 * transfers (see the note in mesh.ts), never to revalue cache hits.
		 */
		abr: { enabled: true }
	});

	// The transport has already measured this link, so the first segment is a
	// measurement rather than a guess (PLAN.md Phase 4).
	if (opts.bandwidthEstimate !== undefined && Number.isFinite(opts.bandwidthEstimate)) {
		if (opts.bandwidthEstimate > 0) {
			player.configure('abr.defaultBandwidthEstimate', opts.bandwidthEstimate);
		}
	}

	if (opts.availableRungs !== undefined) {
		applyRungRestrictions(player, opts.availableRungs, opts.mpd);
	}
}

/**
 * The host playing its own tier-2 file back through its own origin.
 *
 * ABR is for a link, and the host has none: every segment it asks for comes out
 * of the ladder in the same tab. Left on, the estimator would time the encoder
 * instead - read a cold rung's first-segment stall as a collapsed network and
 * drop the one viewer with no network at all to the bottom rung. So it is off,
 * and the opening estimate is set past any rung's bandwidth, which is what
 * makes the one choice Shaka still makes (the first) land on rep 0.
 */
export function configureHostPlayer(player: shaka.Player): void {
	configurePlayer(player, {});
	player.configure({ abr: { enabled: false, defaultBandwidthEstimate: Number.MAX_SAFE_INTEGER } });
}

/**
 * PLAN.md 4.5: serve a rung only once its leading segments are ready, so encode
 * latency is never read by the estimator as network congestion.
 *
 * The policy itself is `rungWindow` in rungs.ts, pure and tested on its own.
 * This is the glue: before load the candidates come from the manifest text
 * (the only source there is, and the only moment that steers the first pick);
 * after load they come from the variants Shaka kept, whose heights are the
 * truth, rep 0's included - `native` has no height until the manifest says.
 *
 * Known limitation, stated rather than hidden: Shaka's restrictions are a
 * numeric window, so they cannot express a gap. The ladder never produces one
 * (it warms and advertises top-down, so every advertised set is a contiguous
 * prefix), and the window below is defensive translation, not the guarantee.
 */
function applyRungRestrictions(player: shaka.Player, rungs: number[], mpd?: string): void {
	let candidates: RungCandidate[] = player.getVariantTracks().flatMap((track) => {
		const rep = repIdOf(track);
		return rep === null || track.height === null
			? []
			: [{ repId: rep, height: track.height, playable: true }];
	});
	if (candidates.length === 0 && mpd !== undefined) {
		const supported = (type: string): boolean =>
			typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type);
		candidates = manifestRungs(mpd, supported);
	}
	// Nothing loaded and no manifest to read: nothing is selectable anyway, and
	// the host's next rung change reapplies this against a loaded one. An
	// audio-only film has no video rung to restrict.
	if (candidates.length === 0) return;

	const window = rungWindow(candidates, rungs);
	// Restricting everything away would lock playback out entirely, which is a
	// worse failure than serving a rung the host did not advertise.
	player.configure('abr.restrictions', window ?? { minHeight: 0, maxHeight: Infinity });
}

/**
 * Seconds buffered ahead of the playhead, read off Shaka's own buffer state.
 * PLAN.md Phase 3 is explicit that we do not track this ourselves; a second
 * copy of the truth is a second thing to desync.
 */
export function playerBufferAhead(player: shaka.Player, video: HTMLMediaElement): number {
	const now = video.currentTime;
	// `total` is what can actually play: the intersection across source buffers,
	// not video alone.
	for (const range of player.getBufferedInfo().total) {
		if (now >= range.start - RANGE_EPSILON_SEC && now < range.end) {
			return Math.max(0, range.end - now);
		}
	}
	// The playhead sits in a gap: honestly zero, which is what a stall is.
	return 0;
}

/**
 * A fully buffered ending cannot refill past the film's duration. Tell the
 * readiness barrier separately so honest buffer seconds do not deadlock it.
 * The caller supplies its low watermark: within that distance of EOF there
 * is no useful refill to wait for. It also covers the few hundred milliseconds
 * between the MPD's longest track and the playable intersection's shortest.
 * Only the playable range at the playhead counts; a later range across a gap
 * or a truncated stream must still be allowed to block.
 */
export function playerAtEnd(
	player: shaka.Player,
	video: HTMLMediaElement,
	endToleranceSec: number
): boolean {
	if (video.ended) return true;
	const { currentTime, duration } = video;
	if (!Number.isFinite(duration) || duration <= 0) return false;
	return player
		.getBufferedInfo()
		.total.some(
			(range) =>
				currentTime >= range.start - RANGE_EPSILON_SEC &&
				currentTime <= range.end + RANGE_EPSILON_SEC &&
				range.end >= duration - endToleranceSec
		);
}

/**
 * A Shaka failure as a sentence someone can act on.
 *
 * `shaka.util.Error.message` is "Shaka Error 4032" and nothing else, which is
 * what the error banner was showing: not silent, but not something anybody
 * watching a film can do anything with. The codes named here are the ones this
 * app can actually produce; the rest keep the bare code, which stays on the
 * end of every message because it is what a bug report needs.
 */
export function describePlaybackError(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	if (typeof code !== 'number') {
		return err instanceof Error ? err.message : 'Playback failed for an unknown reason.';
	}
	const { Code } = shaka.util.Error;
	let what: string;
	switch (code) {
		case Code.CONTENT_UNSUPPORTED_BY_BROWSER:
			what = "This browser can't play the format this video is in.";
			break;
		case Code.BAD_HTTP_STATUS:
		case Code.HTTP_ERROR:
		case Code.TIMEOUT:
			what = "Part of the video didn't arrive from the host. The connection may have dropped.";
			break;
		case Code.VIDEO_ERROR:
		case Code.MEDIA_SOURCE_OPERATION_FAILED:
		case Code.MEDIA_SOURCE_OPERATION_THREW:
			what = 'This browser hit an error decoding the video.';
			break;
		default:
			what = 'Playback failed.';
	}
	return `${what} (Shaka error ${code})`;
}

/**
 * What Shaka's ABR estimator currently believes the link can carry, bits/sec.
 *
 * The rung a guest plays is a function of this number and nothing else, so
 * without it "the guest parked below native" is unfalsifiable: a starved
 * estimator, an honest reading of a slow link, and a rung restriction all look
 * identical from outside. Phase 5 turned that from an inconvenience into a
 * blind spot, because the mesh's whole purpose is to change what the link can
 * carry without changing what Shaka is asked.
 */
export function bandwidthEstimate(player: shaka.Player): number {
	const est = player.getStats().estimatedBandwidth;
	return Number.isFinite(est) ? est : 0;
}

/** The active variant's rung, i.e. its MPD RepresentationID. */
export function currentRung(player: shaka.Player): number | null {
	const active = player.getVariantTracks().find((track) => track.active);
	return active === undefined ? null : repIdOf(active);
}

function repIdOf(track: shaka.extern.Track): number | null {
	const id = track.originalVideoId;
	// Guard the format rather than trusting Number(): Number('') is 0, and rep 0
	// is a real rung.
	if (id === null || !/^\d+$/.test(id)) return null;
	return Number(id);
}
