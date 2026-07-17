/**
 * The host origin, assembled (PLAN.md 3).
 *
 * "The host becomes an origin server for its own local file." This is where
 * that becomes one object: source.ts reads byte ranges and emits rep 0's CMAF
 * segments, ladder.ts encodes the other rungs from those segments, manifest.ts
 * describes the result, and everything above here just asks for bytes by
 * (repId, track, segIdx) and neither knows nor cares which of those answered.
 */

import { buildMpd } from './manifest';
import { createSource } from './source';
import { createLadder, type Ladder } from './ladder';
import {
	LADDER,
	NATIVE_REP,
	type ManifestInput,
	type Origin,
	type ProbeResult,
	type RepresentationInfo
} from './types';
import type { Track } from '$lib/protocol/control';

/**
 * Note the MPD lists every rung the host *can* produce, not only the warm ones.
 * A static VOD manifest is fetched once, so a rung that appears later could
 * never reach a loaded player. Warmth is enforced instead by
 * `availableRungs()` riding the control channel onto Shaka's abr.restrictions
 * (PLAN.md 4.5), which is the same guarantee by the mechanism the plan names.
 */
export async function createOrigin(file: File, probe: ProbeResult): Promise<Origin> {
	if (probe.tier === 'reject') {
		throw new Error(probe.reason);
	}

	const source = await createSource(file, probe);

	let ladder: Ladder;
	try {
		ladder = createLadder(source, probe);
		// Fixes the codec strings the manifest needs. Fast: a few
		// isConfigSupported calls, no encoding.
		await ladder.ready();
	} catch (err) {
		source.close();
		throw new Error(
			`This file needs transcoding and the encoder could not start: ${(err as Error).message}`
		);
	}

	// A tier-2 file whose rep 0 must come from the encoder is unplayable if the
	// encoder could not configure that rep. Fail here, with the reason, rather
	// than serving a manifest whose every segment request will throw.
	if (probe.videoAction === 'transcode' && !ladder.representation(NATIVE_REP, 'video')) {
		source.close();
		ladder.close();
		throw new Error(
			`The video track is ${probe.video?.codec ?? 'unknown'}, which this browser cannot re-encode for playback.`
		);
	}
	if (probe.audioAction === 'transcode' && !ladder.representation(NATIVE_REP, 'audio')) {
		source.close();
		ladder.close();
		throw new Error(
			`The audio track is ${probe.audio?.codec ?? 'unknown'}, which this browser cannot re-encode for playback.`
		);
	}

	const reps = (track: Track): RepresentationInfo[] =>
		LADDER.map((r) => ladder.representation(r.id, track)).filter(
			(r): r is RepresentationInfo => r !== null
		);

	const videoReps = source.videoIndex ? reps('video') : [];
	const audioReps = source.audioIndex ? reps('audio') : [];

	const input: ManifestInput = {
		durationSec: source.durationSec,
		video:
			source.videoIndex && videoReps.length ? { index: source.videoIndex, reps: videoReps } : null,
		audio:
			source.audioIndex && audioReps.length ? { index: source.audioIndex, reps: audioReps } : null
	};

	if (!input.video && !input.audio) {
		source.close();
		ladder.close();
		throw new Error('No playable track survived probing, so there is nothing to stream.');
	}

	const mpd = buildMpd(input, probe.video ? { frameRate: String(probe.video.fps) } : {});

	return {
		probe,
		mpd,
		durationSec: source.durationSec,
		getInit: (repId, track) => ladder.getInit(repId, track),
		getSegment: (repId, track, segIdx) => {
			// The request itself is the demand signal the ladder prioritises by,
			// and it is what keeps generation just ahead of the playhead.
			ladder.note(repId, track, segIdx);
			return ladder.getSegment(repId, track, segIdx);
		},
		availableRungs: () => ladder.availableRungs(),
		onRungsChanged: (cb) => {
			ladder.onRungsChanged(cb);
		},
		close: () => {
			ladder.close();
			source.close();
		}
	};
}
