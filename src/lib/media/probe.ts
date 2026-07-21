/**
 * File probe and tier classification (PLAN.md 4.3, 4.4, 4.8; Phase 2).
 *
 * Runs on file select, before anything else, and answers one question: what
 * would this browser have to do to this file in order to stream it?
 *
 * Two rules shape everything below.
 *
 * Never read the whole file. The moov is located by following mp4box's
 * `nextParsePosition` over `File.slice()` ranges. That is the inversion the
 * rebuild exists for (PLAN.md 3), and it starts here because the probe is the
 * first thing that touches the file.
 *
 * Never assume a capability. PLAN.md 4.4 assumes AC-3/E-AC-3/DTS can always be
 * rescued through `AudioDecoder`; that is optimistic. A browser ships one set
 * of audio decoders, and WebCodecs draws from the same set MSE does, so a
 * browser with no AC-3 decoder has no AC-3 decoder for us either. PLAN.md 4.8
 * is the tiebreaker: feature-detect, then say what is actually true. Hence a
 * file whose only defect is AC-3 audio may be tier 'transcode' on one machine
 * and tier 'reject' on the next, and both answers are correct.
 */

import { createFile, MP4BoxBuffer } from 'mp4box';
import type { Box, ISOFile, Movie, SampleEntry, Track as Mp4Track } from 'mp4box';
import type {
	AudioTrackInfo,
	Capabilities,
	ProbeResult,
	Tier,
	TrackAction,
	TrackInfo,
	VideoTrackInfo
} from '$lib/media/types';

/** Read granularity while hunting for the moov. */
const PROBE_CHUNK_BYTES = 1024 * 1024;

/**
 * Tail windows for the fallback path, growing because a two-hour movie's sample
 * tables run to tens of megabytes and a 2MB window would land inside the moov
 * rather than at its start.
 */
const TAIL_WINDOWS_BYTES = [2, 8, 32].map((mb) => mb * 1024 * 1024);

/** A malformed file must terminate the parse loop, not spin it. */
const MAX_APPENDS = 64;

/** PLAN.md 4.5: H.264 Main@4.2 is what every encoded rung is made of. */
const TRANSCODE_VIDEO_CODEC = 'avc1.4d402a';

/** PLAN.md 4.4: the one audio codec we ever encode to. */
const TRANSCODE_AUDIO_CODEC = 'mp4a.40.2';

/** Mirrors LADDER rung 1 (PLAN.md 4.5): the encode we must be able to run. */
const VIDEO_ENCODE_PROBE: VideoEncoderConfig = {
	codec: TRANSCODE_VIDEO_CODEC,
	width: 1280,
	height: 720,
	bitrate: 2_500_000,
	framerate: 30
};

const AUDIO_ENCODE_PROBE: AudioEncoderConfig = {
	codec: TRANSCODE_AUDIO_CODEC,
	sampleRate: 48_000,
	numberOfChannels: 2,
	bitrate: 128_000
};

/** Baselines for the Capabilities flags: can WebCodecs handle what we emit? */
const VIDEO_DECODE_PROBE: VideoDecoderConfig = {
	codec: 'avc1.640028',
	codedWidth: 1920,
	codedHeight: 1080
};

const AUDIO_DECODE_PROBE: AudioDecoderConfig = {
	codec: TRANSCODE_AUDIO_CODEC,
	sampleRate: 48_000,
	numberOfChannels: 2
};

/**
 * WebCodecs decoder descriptions live in these boxes, and in every case the
 * box payload *is* the description the codec registration asks for.
 */
const VIDEO_CONFIG_BOXES = ['avcC', 'hvcC', 'av1C', 'vpcC', 'vvcC'];

/** ISO 14496-1 descriptor tags. mp4box parses the esds tree but exports no type for it. */
const DECODER_CONFIG_DESCR_TAG = 0x04;
const DEC_SPECIFIC_INFO_TAG = 0x05;

// ---------------------------------------------------------------------------
// Capabilities (PLAN.md 4.8)
// ---------------------------------------------------------------------------

type TypeSupportChecker = { isTypeSupported(type: string): boolean };

function globalValue(name: string): unknown {
	return (globalThis as unknown as Record<string, unknown>)[name];
}

function typeSupportChecker(name: string): TypeSupportChecker | null {
	const ctor = globalValue(name) as TypeSupportChecker | undefined;
	return ctor && typeof ctor.isTypeSupported === 'function' ? ctor : null;
}

/**
 * MediaSource where it exists, ManagedMediaSource where it does not (iPhone
 * Safari ships only the latter). Both answer the same question identically.
 */
function playbackChecker(): TypeSupportChecker | null {
	return typeSupportChecker('MediaSource') ?? typeSupportChecker('ManagedMediaSource');
}

/**
 * `isConfigSupported` rejects with TypeError on a codec string it cannot even
 * parse, which is a "no" wearing a different hat. Treat both the same.
 */
async function isSupported(probe: () => Promise<{ supported?: boolean }>): Promise<boolean> {
	try {
		return (await probe()).supported === true;
	} catch {
		return false;
	}
}

export async function detectCapabilities(): Promise<Capabilities> {
	const webCodecs =
		typeof VideoDecoder !== 'undefined' &&
		typeof VideoEncoder !== 'undefined' &&
		typeof AudioDecoder !== 'undefined' &&
		typeof AudioEncoder !== 'undefined';

	const [videoDecode, videoEncode, audioDecode, audioEncode] = await Promise.all([
		webCodecs ? isSupported(() => VideoDecoder.isConfigSupported(VIDEO_DECODE_PROBE)) : false,
		webCodecs ? isSupported(() => VideoEncoder.isConfigSupported(VIDEO_ENCODE_PROBE)) : false,
		webCodecs ? isSupported(() => AudioDecoder.isConfigSupported(AUDIO_DECODE_PROBE)) : false,
		webCodecs ? isSupported(() => AudioEncoder.isConfigSupported(AUDIO_ENCODE_PROBE)) : false
	]);

	return {
		mediaSource: typeSupportChecker('MediaSource') !== null,
		managedMediaSource: typeSupportChecker('ManagedMediaSource') !== null,
		webCodecs,
		videoDecode,
		videoEncode,
		audioDecode,
		audioEncode
	};
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type ParsedFile = { iso: ISOFile; info: Movie };

async function readRange(file: File, start: number, end: number): Promise<MP4BoxBuffer> {
	const buf = await file.slice(start, Math.min(end, file.size)).arrayBuffer();
	return MP4BoxBuffer.fromArrayBuffer(buf, start);
}

/** mp4box throws on some malformed input. A bad file is a probe result, not a crash. */
function append(iso: ISOFile, buf: MP4BoxBuffer): number | undefined {
	try {
		return iso.appendBuffer(buf);
	} catch {
		return undefined;
	}
}

function newIsoFile(): { iso: ISOFile; getInfo: () => Movie | null } {
	// keepMdatData=false: the probe must never retain sample payload. Skipping a
	// 4GB mdat is the entire point.
	const iso = createFile(false);
	let info: Movie | null = null;
	iso.onReady = (i) => {
		info = i;
	};
	return { iso, getInfo: () => info };
}

/**
 * Streams from byte 0, following `nextParsePosition`. On a moov-at-end file
 * mp4box reports the offset just past the mdat it cannot buffer, so this walks
 * straight from the ftyp to the trailing moov and reads neither the payload in
 * between nor anything it does not need.
 */
async function parseFromHead(file: File): Promise<ParsedFile | null> {
	const { iso, getInfo } = newIsoFile();
	let pos = 0;

	for (let i = 0; i < MAX_APPENDS && pos < file.size; i++) {
		const buf = await readRange(file, pos, pos + PROBE_CHUNK_BYTES);
		if (buf.byteLength === 0) break;

		const next = append(iso, buf);
		const info = getInfo();
		if (info) return { iso, info };

		// No forward progress means mp4box cannot get further with more bytes
		// from here: either the box chain is broken or the size fields lie.
		if (next === undefined || !Number.isFinite(next) || next <= pos) break;
		pos = next;
	}
	return null;
}

/**
 * Second chance for files the head walk gives up on: hand mp4box one large
 * contiguous window at the end of the file and let it resume there.
 *
 * mp4box refuses to start parsing unless the first buffer is at fileStart 0, so
 * the head still goes in first to establish the ftyp and the mdat header; the
 * window then covers wherever the parser asked to resume.
 *
 * Measured limit, so nobody expects more of this than it gives: this cannot
 * rescue a file whose mdat size field is wrong. mp4box resumes at the offset it
 * recorded from that field, so if the field lies, no set of bytes we supply is
 * at the offset it wants. Those files reject, with a message that says so. The
 * moov-at-end shape this exists to catch is in practice already handled by the
 * head walk, which jumps the mdat outright.
 */
async function parseFromTail(file: File, windowBytes: number): Promise<ParsedFile | null> {
	const { iso, getInfo } = newIsoFile();

	const head = await readRange(file, 0, Math.min(PROBE_CHUNK_BYTES, file.size));
	if (head.byteLength === 0) return null;
	append(iso, head);
	const early = getInfo();
	if (early) return { iso, info: early };

	const start = Math.max(0, file.size - windowBytes);
	const tail = await readRange(file, start, file.size);
	if (tail.byteLength === 0) return null;
	append(iso, tail);

	const info = getInfo();
	return info ? { iso, info } : null;
}

async function parseMoov(file: File): Promise<ParsedFile | null> {
	const head = await parseFromHead(file);
	if (head) return head;

	for (const window of TAIL_WINDOWS_BYTES) {
		const tail = await parseFromTail(file, window);
		if (tail) return tail;
		// The window already spanned the file; growing it reads the same bytes.
		if (window >= file.size) break;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Track extraction
// ---------------------------------------------------------------------------

function sampleEntry(iso: ISOFile, trackId: number): SampleEntry | undefined {
	const trak = iso.getTrackById(trackId);
	return trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
}

function childBox(parent: Box, types: string[]): Box | undefined {
	return parent.boxes?.find((b) => types.includes(b.type));
}

/**
 * Reads a box's payload straight back off disk. `start` is an absolute file
 * offset in every parse path above, so this is exact for any container layout
 * and does not depend on mp4box having a writer for the box in question.
 */
async function boxPayload(file: File, box: Box): Promise<Uint8Array | undefined> {
	const { start, hdr_size: hdr, size } = box;
	if (start === undefined || hdr === undefined || !size) return undefined;
	const from = start + hdr;
	const to = start + size;
	if (to <= from || to > file.size) return undefined;
	return new Uint8Array(await file.slice(from, to).arrayBuffer());
}

type DescriptorNode = {
	data?: Uint8Array;
	findDescriptor(tag: number): DescriptorNode | undefined;
};

type EsdsBox = Box & { esd?: DescriptorNode };

/**
 * The esds usually hangs off the sample entry, but QuickTime-derived files
 * nest it one level down inside a `wave` box. That is not an exotic shape:
 * ffmpeg's `mov` muxer writes it, so does Final Cut, so do plenty of cameras.
 *
 * mp4box's own codec-string logic reads `this.esds ?? this.wave?.esds`, which
 * is why such a file still reports `mp4a.40.2`. Looking only at direct children
 * therefore produces the contradiction rather than an honest gap: a codec
 * string that proves an esds was parsed, next to a description claiming there
 * is none. Match mp4box's lookup so the two agree.
 */
function findEsds(entry: SampleEntry): EsdsBox | undefined {
	const direct = childBox(entry, ['esds']);
	if (direct) return direct as EsdsBox;
	const wave = childBox(entry, ['wave']);
	return wave ? (childBox(wave, ['esds']) as EsdsBox | undefined) : undefined;
}

async function videoDescription(
	file: File,
	iso: ISOFile,
	trackId: number
): Promise<Uint8Array | undefined> {
	const entry = sampleEntry(iso, trackId);
	if (!entry) return undefined;
	const box = childBox(entry, VIDEO_CONFIG_BOXES);
	return box ? boxPayload(file, box) : undefined;
}

/**
 * AAC's WebCodecs description is the AudioSpecificConfig, which is buried in
 * the esds descriptor tree rather than being the esds payload itself. Codecs
 * without an esds (Opus, FLAC) get no description: their registrations expect
 * a specific header we would have to synthesise, and a wrong description fails
 * louder and later than no description at all. The transcoder can recover one
 * from the init segment if it ever needs it.
 */
async function audioDescription(iso: ISOFile, trackId: number): Promise<Uint8Array | undefined> {
	const entry = sampleEntry(iso, trackId);
	if (!entry) return undefined;
	const dsi = findEsds(entry)
		?.esd?.findDescriptor(DECODER_CONFIG_DESCR_TAG)
		?.findDescriptor(DEC_SPECIFIC_INFO_TAG);
	return dsi?.data ? new Uint8Array(dsi.data) : undefined;
}

function trackDurationSec(t: Mp4Track): number {
	const timescale = t.timescale || 1;
	const ticks = t.duration || t.samples_duration || 0;
	return ticks > 0 ? ticks / timescale : 0;
}

/**
 * The longest span with no sync sample to cut at: sync-to-sync, plus the tail
 * from the last sync sample to the end of the track. Segmentation cuts only at
 * sync samples (source.ts planByRap), so this is the widest segment the file
 * can force onto the grid every representation shares. `is_sync` is mp4box's
 * parse of stss, and it is true for every sample when the track has none --
 * an all-intra track, whose widest gap is a single frame. Pure moov
 * arithmetic: nothing here reads the payload.
 */
function maxRapGapSec(iso: ISOFile, trackId: number): number {
	const trak = iso.getTrackById(trackId);
	const samples = trak?.samples ?? [];
	if (samples.length === 0) return 0;
	const timescale = trak.mdia?.mdhd?.timescale || 1;
	let maxTicks = 0;
	let lastSync = samples[0].dts;
	for (const s of samples) {
		if (!s.is_sync) continue;
		if (s.dts - lastSync > maxTicks) maxTicks = s.dts - lastSync;
		lastSync = s.dts;
	}
	const last = samples[samples.length - 1];
	const tail = last.dts + (last.duration || 0) - lastSync;
	if (tail > maxTicks) maxTicks = tail;
	return maxTicks / timescale;
}

/** Average, not nominal: VFR files have no nominal rate and this is what they are. */
function trackFps(t: Mp4Track): number {
	const sec = (t.samples_duration || t.duration || 0) / (t.timescale || 1);
	if (!(sec > 0) || !t.nb_samples) return 0;
	return Math.round((t.nb_samples / sec) * 1000) / 1000;
}

function finiteBitrate(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

async function videoTrackInfo(file: File, iso: ISOFile, t: Mp4Track): Promise<VideoTrackInfo> {
	return {
		id: t.id,
		kind: 'video',
		codec: t.codec,
		timescale: t.timescale || 1,
		durationSec: trackDurationSec(t),
		width: t.video?.width || Math.round(t.track_width) || 0,
		height: t.video?.height || Math.round(t.track_height) || 0,
		fps: trackFps(t),
		bitrate: finiteBitrate(t.bitrate),
		maxRapGapSec: maxRapGapSec(iso, t.id),
		description: await videoDescription(file, iso, t.id)
	};
}

async function audioTrackInfo(iso: ISOFile, t: Mp4Track): Promise<AudioTrackInfo> {
	return {
		id: t.id,
		kind: 'audio',
		codec: t.codec,
		timescale: t.timescale || 1,
		durationSec: trackDurationSec(t),
		channels: t.audio?.channel_count || 0,
		sampleRate: t.audio?.sample_rate || 0,
		bitrate: finiteBitrate(t.bitrate),
		description: await audioDescription(iso, t.id)
	};
}

// ---------------------------------------------------------------------------
// Classification (PLAN.md 4.3, 4.8)
// ---------------------------------------------------------------------------

/**
 * The widest keyframe gap a file may have and still stream. Segments target
 * 4s (PLAN.md 4.1); a 30s gap is already a segment an order of magnitude too
 * large, one whole fetch and one seek target for half a minute of film.
 *
 * Past this, no tier helps. Transcoding cannot rescue the file: every
 * representation shares rep 0's segment grid (types.ts TrackIndex -- the CMAF
 * contract that makes rung switching work), so encoded rungs inherit the same
 * giant segments, keyframe-dense on the inside but still one fetch and one
 * seek target apiece. Re-gridding a transcode would mean cutting rep 0
 * mid-GOP and prerolling the decoder from the previous sync sample, which on
 * exactly the file this guards against means decoding from the start of the
 * movie. So the honest verdict is a reject that names the cause.
 */
const MAX_RAP_GAP_SEC = 30;

/** Why a sparse-keyframe file cannot stream, naming the measured gap. */
function sparseKeyframeReason(video: VideoTrackInfo): string {
	const gap = Math.round(video.maxRapGapSec);
	return (
		`The video track's keyframes are up to ${gap}s apart, and a stream can only be cut at keyframes, ` +
		`so this file would become a few enormous segments with no way to seek or adapt quality. ` +
		`It needs re-encoding with a normal keyframe interval (a few seconds) before it can be shared.`
	);
}

function isPlayable(info: TrackInfo, checker: TypeSupportChecker | null): boolean {
	if (!checker || !info.codec) return false;
	const mime = info.kind === 'video' ? 'video/mp4' : 'audio/mp4';
	try {
		return checker.isTypeSupported(`${mime}; codecs="${info.codec}"`);
	} catch {
		return false;
	}
}

async function isDecodable(info: TrackInfo): Promise<boolean> {
	if (!info.codec) return false;
	if (info.kind === 'video') {
		if (typeof VideoDecoder === 'undefined') return false;
		return isSupported(() =>
			VideoDecoder.isConfigSupported({
				codec: info.codec,
				codedWidth: info.width || undefined,
				codedHeight: info.height || undefined,
				description: info.description
			})
		);
	}
	if (typeof AudioDecoder === 'undefined') return false;
	return isSupported(() =>
		AudioDecoder.isConfigSupported({
			codec: info.codec,
			sampleRate: info.sampleRate || AUDIO_ENCODE_PROBE.sampleRate,
			numberOfChannels: info.channels || AUDIO_ENCODE_PROBE.numberOfChannels,
			description: info.description
		})
	);
}

/** MPEG-4 object type indications that turn up in real remuxes (ISO 14496-1). */
function mp4aLabel(oti: string | undefined): string {
	switch ((oti ?? '').toLowerCase()) {
		case '40':
		case '66':
		case '67':
		case '68':
			return 'AAC';
		case '69':
		case '6b':
			return 'MP3';
		case 'a5':
			return 'AC-3';
		case 'a6':
			return 'E-AC-3';
		case 'a9':
		case 'aa':
		case 'ab':
		case 'ac':
			return 'DTS';
		default:
			return oti ? `MPEG-4 audio (object type 0x${oti})` : 'MPEG-4 audio';
	}
}

/**
 * Plain-language codec names. Every rejection message has to name the real
 * cause, and `hvc1.2.4.L153.B0` names nothing to the person holding the file.
 */
function codecLabel(codec: string): string {
	const parts = codec.split('.');
	switch (parts[0].toLowerCase()) {
		case 'avc1':
		case 'avc3':
			return 'H.264';
		case 'hvc1':
		case 'hev1':
			return 'HEVC (H.265)';
		case 'vvc1':
		case 'vvi1':
			return 'VVC (H.266)';
		case 'av01':
			return 'AV1';
		case 'vp09':
			return 'VP9';
		case 'vp08':
			return 'VP8';
		case 'mp4v':
			return 'MPEG-4 Part 2';
		case 'mjpg':
			return 'Motion JPEG';
		case 'ac-3':
			return 'AC-3';
		case 'ec-3':
			return 'E-AC-3';
		case 'ac-4':
			return 'AC-4';
		case 'opus':
			return 'Opus';
		case 'flac':
			return 'FLAC';
		case 'alac':
			return 'ALAC';
		case 'dtsc':
		case 'dtse':
		case 'dtsh':
		case 'dtsl':
			return 'DTS';
		case 'mha1':
		case 'mha2':
		case 'mhm1':
		case 'mhm2':
			return 'MPEG-H 3D Audio';
		case 'mp4a':
			return mp4aLabel(parts[1]);
		default:
			return codec;
	}
}

type Verdict = { action: TrackAction; reason: string | null };

/**
 * PLAN.md 4.3's three tiers, per track. `reason` is set only when the track is
 * unrecoverable, and it says which of the three possible causes it actually
 * was: no decoder, no WebCodecs at all, or no encoder to convert into.
 */
async function classifyTrack(
	info: TrackInfo,
	checker: TypeSupportChecker | null,
	caps: Capabilities
): Promise<Verdict> {
	if (isPlayable(info, checker)) return { action: 'passthrough', reason: null };

	const kind = info.kind;
	const label = codecLabel(info.codec);
	const target = kind === 'video' ? 'H.264' : 'AAC';

	if (!caps.webCodecs) {
		return {
			action: 'none',
			reason: `The ${kind} track is ${label}, which this browser cannot play, and this browser has no WebCodecs support, so there is nothing here that can convert it to ${target}.`
		};
	}

	if (!(await isDecodable(info))) {
		return {
			action: 'none',
			reason: `The ${kind} track is ${label} and this browser cannot decode it, so it cannot be converted to ${target} either.`
		};
	}

	const encodable = kind === 'video' ? caps.videoEncode : caps.audioEncode;
	if (!encodable) {
		return {
			action: 'none',
			reason: `The ${kind} track is ${label}, which this browser cannot play. It can be decoded, but this browser has no ${target} encoder to convert it into.`
		};
	}

	return { action: 'transcode', reason: null };
}

/** "the AC-3 audio track must be converted to AAC" */
function transcodeClause(info: TrackInfo): string {
	const target = info.kind === 'video' ? 'H.264' : 'AAC';
	return `the ${codecLabel(info.codec)} ${info.kind} track must be converted to ${target}`;
}

/** "H.264 video and AAC audio" */
function passthroughList(tracks: TrackInfo[]): string {
	return tracks.map((t) => `${codecLabel(t.codec)} ${t.kind}`).join(' and ');
}

function directReason(video: VideoTrackInfo | null, audio: AudioTrackInfo | null): string {
	const present = [video, audio].filter((t): t is TrackInfo => t !== null);
	const list = passthroughList(present);
	const verb = present.length > 1 ? 'play' : 'plays';
	const missing = !video
		? ' The file has no video track.'
		: !audio
			? ' The file has no audio track.'
			: '';
	return `${list} ${verb} natively here, so the file streams untouched.${missing}`;
}

// ---------------------------------------------------------------------------
// Container sniffing, so a rejection can say what the file actually is
// ---------------------------------------------------------------------------

function fourcc(bytes: Uint8Array, offset: number): string {
	if (bytes.length < offset + 4) return '';
	return String.fromCharCode(
		bytes[offset],
		bytes[offset + 1],
		bytes[offset + 2],
		bytes[offset + 3]
	);
}

type Container = 'mp4' | 'matroska' | 'avi' | 'ogg' | 'flv' | 'unknown';

async function sniffContainer(file: File): Promise<Container> {
	let head: Uint8Array;
	try {
		head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
	} catch {
		return 'unknown';
	}
	if (fourcc(head, 4) === 'ftyp') return 'mp4';
	if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)
		return 'matroska';
	if (fourcc(head, 0) === 'RIFF' && fourcc(head, 8) === 'AVI ') return 'avi';
	if (fourcc(head, 0) === 'OggS') return 'ogg';
	if (fourcc(head, 0).slice(0, 3) === 'FLV') return 'flv';
	return 'unknown';
}

const REMUX_HINT = 'Remux it to MP4 first: ffmpeg -i input -c copy output.mp4';

function unreadableReason(container: Container): string {
	switch (container) {
		case 'mp4':
			return 'This MP4 has no readable moov box, the index that says where every frame lives, so the file is truncated or damaged.';
		case 'matroska':
			return `This is a Matroska file (.mkv or .webm), not an MP4, and its layout is not one this app can read. ${REMUX_HINT}`;
		case 'avi':
			return `This is an AVI file, not an MP4. ${REMUX_HINT}`;
		case 'ogg':
			return `This is an Ogg file, not an MP4. ${REMUX_HINT}`;
		case 'flv':
			return `This is a Flash Video file (.flv), not an MP4. ${REMUX_HINT}`;
		default:
			return `This file is not an MP4 or MOV container, so there is no moov box to read tracks from. ${REMUX_HINT}`;
	}
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

function rejected(reason: string, capabilities: Capabilities): ProbeResult {
	return {
		tier: 'reject',
		reason,
		video: null,
		audio: null,
		videoAction: 'none',
		audioAction: 'none',
		durationSec: 0,
		brands: [],
		capabilities
	};
}

export async function probeFile(file: File): Promise<ProbeResult> {
	const capabilities = await detectCapabilities();

	// Sniff before parsing. A positively identified non-MP4 container will not
	// parse no matter how much of it we read, and the parse attempts below would
	// pull ~40MB off disk to reach the same conclusion. 'unknown' still gets a
	// parse attempt: an old QuickTime file with an unusual first atom is better
	// answered by the parser than by a magic-number guess.
	const container = await sniffContainer(file);
	if (container !== 'mp4' && container !== 'unknown') {
		return rejected(unreadableReason(container), capabilities);
	}

	const parsed = await parseMoov(file);
	if (!parsed) return rejected(unreadableReason(container), capabilities);

	const { iso, info } = parsed;
	const brands = info.brands ?? [];

	// The first of each. PLAN.md 4.5 has one video and one audio representation;
	// alternate language or commentary tracks are not in scope and picking the
	// first is the same choice every player makes by default.
	const videoSrc = info.videoTracks?.[0];
	const audioSrc = info.audioTracks?.[0];

	const video = videoSrc ? await videoTrackInfo(file, iso, videoSrc) : null;
	const audio = audioSrc ? await audioTrackInfo(iso, audioSrc) : null;

	const movieDurationSec = info.timescale > 0 ? (info.duration || 0) / info.timescale : 0;
	const durationSec = Math.max(movieDurationSec, video?.durationSec ?? 0, audio?.durationSec ?? 0);

	if (!video && !audio) {
		const result = rejected(
			'This file has no video and no audio track, only metadata, so there is nothing to play.',
			capabilities
		);
		return { ...result, brands, durationSec };
	}

	const checker = playbackChecker();
	if (!checker) {
		const result = rejected(
			'This browser has neither MediaSource nor ManagedMediaSource, so it cannot play a segmented stream at all, whatever the file contains. Hosting needs a current desktop browser.',
			capabilities
		);
		return { ...result, video, audio, brands, durationSec };
	}

	const videoVerdict: Verdict = video
		? await classifyTrack(video, checker, capabilities)
		: { action: 'none', reason: null };
	const audioVerdict: Verdict = audio
		? await classifyTrack(audio, checker, capabilities)
		: { action: 'none', reason: null };

	const blockers = [videoVerdict.reason, audioVerdict.reason].filter(
		(r): r is string => r !== null
	);

	// Sparse keyframes block every tier, whatever the codecs said: the segment
	// grid is shared by all representations, so neither passthrough nor
	// transcode can produce a seekable stream from a single-GOP file (see
	// MAX_RAP_GAP_SEC). Checked after the codec verdicts so a file that is
	// wrong twice is told both truths.
	if (video && video.maxRapGapSec > MAX_RAP_GAP_SEC) {
		blockers.push(sparseKeyframeReason(video));
	}

	let tier: Tier;
	let reason: string;
	if (blockers.length > 0) {
		tier = 'reject';
		reason = blockers.join(' ');
	} else if (videoVerdict.action === 'transcode' || audioVerdict.action === 'transcode') {
		tier = 'transcode';
		const clauses: string[] = [];
		if (video && videoVerdict.action === 'transcode') clauses.push(transcodeClause(video));
		if (audio && audioVerdict.action === 'transcode') clauses.push(transcodeClause(audio));
		reason = `This file cannot stream untouched: ${clauses.join(' and ')}.`;
	} else {
		tier = 'direct';
		reason = directReason(video, audio);
	}

	return {
		tier,
		reason,
		video,
		audio,
		videoAction: videoVerdict.action,
		audioAction: audioVerdict.action,
		durationSec,
		brands,
		capabilities
	};
}

/**
 * PLAN.md 4.3 sequencing. The probe classifies honestly in Phase 2 but the
 * transcoder lands in Phase 4, so the UI needs to distinguish "we will convert
 * this" from "we could convert this, and that code does not exist yet". Neither
 * is "unsupported", which is what a user would otherwise be told about a file
 * that is perfectly fine.
 */
export function tierMessage(p: ProbeResult, transcoderAvailable: boolean): string {
	if (p.tier !== 'transcode') return p.reason;

	const clauses: string[] = [];
	if (p.video && p.videoAction === 'transcode') clauses.push(transcodeClause(p.video));
	if (p.audio && p.audioAction === 'transcode') clauses.push(transcodeClause(p.audio));
	const list = clauses.join(' and ');

	return transcoderAvailable
		? `This file needs transcoding: ${list}. The host converts it while it streams.`
		: `This file needs transcoding, which is not built yet: ${list}.`;
}
