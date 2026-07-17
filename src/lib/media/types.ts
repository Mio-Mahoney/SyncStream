/**
 * Shared media contracts.
 *
 * These types are the seam between the probe (PLAN.md 4.3), the host origin
 * (4.1), the manifest, and the Phase 4 transcoder (4.5). They are declared in
 * one place because the CMAF contract -- every rung shares segment boundaries
 * and timescale with rep 0 -- is a cross-module invariant, and an invariant
 * split across four files is an invariant nobody maintains.
 */

import type { Track } from '$lib/protocol/control';

/** PLAN.md 4.3: probe and tier, not fail-loudly. */
export type Tier = 'direct' | 'transcode' | 'reject';

/** What we must do to a track to make it playable in a browser. */
export type TrackAction = 'passthrough' | 'transcode' | 'none';

export type VideoTrackInfo = {
	id: number;
	kind: 'video';
	/** RFC 6381 codec string, e.g. `avc1.640028`. */
	codec: string;
	timescale: number;
	durationSec: number;
	width: number;
	height: number;
	fps: number;
	bitrate: number;
	/** Raw avcC/hvcC decoder config, needed to configure a VideoDecoder. */
	description?: Uint8Array;
};

export type AudioTrackInfo = {
	id: number;
	kind: 'audio';
	codec: string;
	timescale: number;
	durationSec: number;
	channels: number;
	sampleRate: number;
	bitrate: number;
	description?: Uint8Array;
};

export type TrackInfo = VideoTrackInfo | AudioTrackInfo;

/**
 * PLAN.md 4.8: feature-detect, never UA-sniff. Every capability claim rots, so
 * we ask the browser rather than assume, and surface the answers in the probe
 * so failure messages can be specific.
 */
export type Capabilities = {
	mediaSource: boolean;
	managedMediaSource: boolean;
	webCodecs: boolean;
	videoDecode: boolean;
	videoEncode: boolean;
	audioDecode: boolean;
	audioEncode: boolean;
};

export type ProbeResult = {
	tier: Tier;
	/** Human-readable and specific. Names the actual cause, never "unsupported". */
	reason: string;
	video: VideoTrackInfo | null;
	audio: AudioTrackInfo | null;
	videoAction: TrackAction;
	audioAction: TrackAction;
	durationSec: number;
	brands: string[];
	capabilities: Capabilities;
};

/** PLAN.md 4.5. The ladder is data, so changing it is a config change. */
export type Rung = {
	id: number;
	label: string;
	/** null means native resolution (rep 0). */
	width: number | null;
	height: number | null;
	/** Target video bitrate in bits/sec. Ignored for rep 0 when passthrough. */
	videoBitrate: number;
	/** False only for rep 0 under direct play. */
	encoded: boolean;
};

/**
 * PLAN.md 4.5. H.264 for every encoded rung: it is the only codec with
 * universally available hardware encode, and we encode in realtime on a
 * machine that is simultaneously a participant.
 */
export const LADDER: readonly Rung[] = [
	{ id: 0, label: 'native', width: null, height: null, videoBitrate: 0, encoded: false },
	{ id: 1, label: '720p', width: 1280, height: 720, videoBitrate: 2_500_000, encoded: true },
	{ id: 2, label: '480p', width: 854, height: 480, videoBitrate: 900_000, encoded: true },
	{ id: 3, label: '360p', width: 640, height: 360, videoBitrate: 400_000, encoded: true }
];

export const NATIVE_REP = 0;

/** One segment's placement on the timeline, in `timescale` units. */
export type SegmentEntry = {
	index: number;
	/** Decode/presentation start, in timescale units. */
	time: number;
	/** Duration in timescale units. */
	duration: number;
};

/**
 * The segment index for one track. Every representation of a track shares this
 * index: identical boundaries, identical timescale. That is the CMAF contract
 * from PLAN.md 4.1 and the reason rung switching works at all.
 */
export type TrackIndex = {
	track: Track;
	timescale: number;
	durationSec: number;
	segments: SegmentEntry[];
};

export type RepresentationInfo = {
	repId: number;
	track: Track;
	/** RFC 6381 codec string as it appears in the manifest. */
	codec: string;
	mimeType: 'video/mp4' | 'audio/mp4';
	bandwidth: number;
	width?: number;
	height?: number;
	audioChannels?: number;
	audioSampleRate?: number;
};

export type ManifestInput = {
	durationSec: number;
	video: { index: TrackIndex; reps: RepresentationInfo[] } | null;
	audio: { index: TrackIndex; reps: RepresentationInfo[] } | null;
};

/**
 * The host's origin, as seen by everything that serves bytes: the control
 * channel handler and the Phase 5 mesh. Whether a segment is a passthrough
 * slice of the user's file or a freshly encoded rung is entirely this
 * interface's problem and nobody else's.
 */
export type Origin = {
	readonly probe: ProbeResult;
	/** The DASH MPD, already generated. */
	readonly mpd: string;
	readonly durationSec: number;

	getInit(repId: number, track: Track): Promise<Uint8Array>;
	getSegment(repId: number, track: Track, segIdx: number): Promise<Uint8Array>;

	/**
	 * Rungs currently safe to advertise. A rung appears here only once its
	 * leading segments are warm, so Shaka's ABR estimator never reads encode
	 * latency as network congestion (PLAN.md 4.2).
	 */
	availableRungs(): number[];
	onRungsChanged(cb: (rungs: number[]) => void): void;

	close(): void;
};

export const SEGMENT_TARGET_SEC = 4;

/** LRU cap for produced segments on the host (PLAN.md 7, Phase 2). */
export const SEGMENT_CACHE_BYTES = 200 * 1024 * 1024;
