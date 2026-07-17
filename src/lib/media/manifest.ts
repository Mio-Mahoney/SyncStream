/**
 * DASH MPD generation (PLAN.md 4.1, Phase 2 "Manifest").
 *
 * The manifest is a real MPD rather than a bespoke JSON blob so that every
 * tool, player, and engineer already understands it. That bargain only pays if
 * what we emit is actually conformant, so the shapes below are deliberate:
 *
 *  - SegmentTemplate + SegmentTimeline, never @duration. Our segments are cut
 *    on sync samples (PLAN.md 4.1), so their durations are not uniform. A fixed
 *    @duration would be a lie that seeking would then act on.
 *  - One SegmentTimeline per AdaptationSet, shared by every Representation in
 *    it. That is the CMAF contract made structural: identical boundaries,
 *    identical timescale across rungs, which is the only reason switching works.
 *  - No presentationTimeOffset. Presentation time therefore equals media time,
 *    which is what `State.mediaTime` on the control channel means. A pto would
 *    silently decouple the sync engine's clock from the media timeline, and it
 *    cannot be applied per-track without destroying the real A/V start offset.
 *  - The presentation duration is measured off the timeline we emit, never off
 *    the duration the caller passes. Follows from the line above: with no pto,
 *    S@t is an absolute media timestamp, so the presentation *ends* at the last
 *    segment's media time -- whereas a caller's `durationSec` is a span, from an
 *    mvhd that counts edit lists and the longest track, or from a subtraction
 *    that cancelled the start offset out. Emitting a span as the end makes a
 *    player clamp the final segment to it and drop the tail of the movie, and no
 *    caller can see the discrepancy because only this file knows what it wrote.
 */

import type { Track } from '$lib/protocol/control';
import {
	SEGMENT_TARGET_SEC,
	type ManifestInput,
	type RepresentationInfo,
	type TrackIndex
} from '$lib/media/types';

export const SCHEME = 'syncstream';

/**
 * Root of every segment URI in the manifest. The canonical parser lives in
 * `$lib/media/shaka/scheme.ts`; this module and that one are two halves of one
 * contract and must move together. The agreed shapes are exactly:
 *   syncstream://rep/{repId}/{track}/init
 *   syncstream://rep/{repId}/{track}/seg/{segIdx}
 */
export function segmentUriBase(): string {
	return `${SCHEME}://rep`;
}

/** Extras the MPD wants that ManifestInput does not carry. */
export type MpdExtras = {
	/** DASH @frameRate: an integer or a "num/den" ratio. Build it with frameRateAttr(). */
	frameRate?: string;
};

/**
 * NTSC rates are exact rationals, not the decimals they round to. Emitting
 * "23.976" would be both invalid (@frameRate is an integer or a ratio) and
 * wrong; players use this value to reason about frame boundaries.
 */
const NTSC_RATES: ReadonlyArray<readonly [number, string]> = [
	[24000 / 1001, '24000/1001'],
	[30000 / 1001, '30000/1001'],
	[60000 / 1001, '60000/1001'],
	[120000 / 1001, '120000/1001']
];

/** fps (as the probe reports it) to a DASH @frameRate attribute value. */
export function frameRateAttr(fps: number): string | null {
	if (!Number.isFinite(fps) || fps <= 0) return null;
	for (const [rate, text] of NTSC_RATES) {
		if (Math.abs(fps - rate) < 0.01) return text;
	}
	if (Math.abs(fps - Math.round(fps)) < 0.001) return String(Math.round(fps));
	return `${Math.round(fps * 1000)}/1000`;
}

/**
 * ISO-8601 duration for MPD@mediaPresentationDuration.
 *
 * Rounds to whole milliseconds *before* decomposing, so 59.9996s renders as
 * PT1M rather than the nonsense PT60S that a naive floor-then-round produces.
 */
export function iso8601Duration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return 'PT0S';
	const totalMs = Math.round(seconds * 1000);
	const hours = Math.floor(totalMs / 3_600_000);
	const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
	const secs = Math.floor((totalMs % 60_000) / 1000);
	const millis = totalMs % 1000;

	let out = 'PT';
	if (hours > 0) out += `${hours}H`;
	if (minutes > 0) out += `${minutes}M`;
	// The S component is only omitted when a larger one already carried the value.
	if (secs > 0 || millis > 0 || out === 'PT') {
		const frac = millis === 0 ? '' : `.${String(millis).padStart(3, '0').replace(/0+$/, '')}`;
		out += `${secs}${frac}S`;
	}
	return out;
}

/** Every string we emit lands in an attribute, so one escaper covers the file. */
function esc(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/** Timescale units and bandwidths are xs:unsignedInt/Long; a stray float is invalid XML. */
function int(value: number, min = 0): string {
	const rounded = Number.isFinite(value) ? Math.round(value) : min;
	return String(Math.max(min, rounded));
}

function initTemplate(track: Track): string {
	return `${segmentUriBase()}/$RepresentationID$/${track}/init`;
}

function mediaTemplate(track: Track): string {
	return `${segmentUriBase()}/$RepresentationID$/${track}/seg/$Number$`;
}

/**
 * Round to integers once, up front. Contiguity and equal-duration are decided
 * by exact comparison, an omitted t= is implied by the preceding run's
 * arithmetic, and the presentation duration is measured off the last entry, so
 * every one of those must run on the very integers we emit. Do it on the raw
 * floats instead and a run can imply a timeline that differs from the one the
 * attributes actually spell out.
 */
function roundedSegments(index: TrackIndex): { time: number; duration: number }[] {
	return index.segments.map((s) => ({
		time: Math.max(0, Math.round(s.time)),
		duration: Math.max(1, Math.round(s.duration))
	}));
}

/** The timescale as emitted, so callers cannot divide by a different one. */
function emittedTimescale(index: TrackIndex): number {
	return Math.max(1, Math.round(index.timescale));
}

/**
 * Where this track's timeline actually ends, in seconds, per the <S> elements
 * we emit rather than per anything the caller told us.
 *
 * S@t values are raw media timestamps and there is no presentationTimeOffset,
 * so presentation time equals media time and this end is absolute, not a span.
 * The last run's implied end is `first.time + d * (r + 1)`, which is exactly the
 * last entry's own time + duration, because that arithmetic is the condition the
 * run was formed under.
 */
function timelineEndSec(index: TrackIndex): number {
	const segs = roundedSegments(index);
	if (segs.length === 0) return 0;
	const last = segs[segs.length - 1];
	return (last.time + last.duration) / emittedTimescale(index);
}

/**
 * <S t= d= r=> with run-length compression. `r` is the count of *additional*
 * repeats, and it may only span segments that are both equal in duration and
 * contiguous, so a gap or a duration change starts a new S with an explicit t.
 */
function segmentTimeline(index: TrackIndex, pad: string): string[] {
	const segs = roundedSegments(index);
	const lines: string[] = [];
	let cursor: number | null = null;

	for (let i = 0; i < segs.length;) {
		const first = segs[i];
		let repeat = 0;
		while (i + repeat + 1 < segs.length) {
			const prev = segs[i + repeat];
			const next = segs[i + repeat + 1];
			if (next.duration !== first.duration) break;
			if (next.time !== prev.time + prev.duration) break;
			repeat++;
		}

		const attrs: string[] = [];
		// t is mandatory on the first S and after any discontinuity; elsewhere it
		// is implied by the previous run's end, which is the whole point of r.
		if (cursor === null || first.time !== cursor) attrs.push(`t="${first.time}"`);
		attrs.push(`d="${first.duration}"`);
		if (repeat > 0) attrs.push(`r="${repeat}"`);
		lines.push(`${pad}<S ${attrs.join(' ')}/>`);

		cursor = first.time + first.duration * (repeat + 1);
		i += repeat + 1;
	}
	return lines;
}

function segmentTemplate(index: TrackIndex, track: Track, pad: string): string[] {
	// timescale must match the TrackIndex exactly: the S values below are raw
	// media timestamps in those units, shared by every rep of this track.
	const open =
		`${pad}<SegmentTemplate timescale="${emittedTimescale(index)}" startNumber="0"` +
		` initialization="${esc(initTemplate(track))}"` +
		` media="${esc(mediaTemplate(track))}">`;
	return [
		open,
		`${pad}  <SegmentTimeline>`,
		...segmentTimeline(index, `${pad}    `),
		`${pad}  </SegmentTimeline>`,
		`${pad}</SegmentTemplate>`
	];
}

function videoAdaptationSet(index: TrackIndex, reps: RepresentationInfo[], extras: MpdExtras) {
	const pad = '    ';
	const maxWidth = Math.max(...reps.map((r) => r.width ?? 0));
	const maxHeight = Math.max(...reps.map((r) => r.height ?? 0));

	const attrs = [
		'id="0"',
		'contentType="video"',
		`mimeType="${esc(reps[0].mimeType)}"`,
		'segmentAlignment="true"',
		'subsegmentAlignment="true"',
		'startWithSAP="1"',
		'subsegmentStartsWithSAP="1"'
	];
	if (maxWidth > 0) attrs.push(`maxWidth="${int(maxWidth)}"`);
	if (maxHeight > 0) attrs.push(`maxHeight="${int(maxHeight)}"`);
	// The ladder never changes frame rate, so it is an AdaptationSet-level fact
	// and every Representation inherits it.
	if (extras.frameRate) attrs.push(`frameRate="${esc(extras.frameRate)}"`);

	const lines = [`${pad}<AdaptationSet ${attrs.join(' ')}>`];
	lines.push(...segmentTemplate(index, 'video', `${pad}  `));
	for (const rep of reps) {
		const repAttrs = [
			`id="${int(rep.repId)}"`,
			`codecs="${esc(rep.codec)}"`,
			`bandwidth="${int(rep.bandwidth, 1)}"`
		];
		if (rep.width) repAttrs.push(`width="${int(rep.width)}"`);
		if (rep.height) repAttrs.push(`height="${int(rep.height)}"`);
		lines.push(`${pad}  <Representation ${repAttrs.join(' ')}/>`);
	}
	lines.push(`${pad}</AdaptationSet>`);
	return lines;
}

const CHANNEL_CONFIG_SCHEME = 'urn:mpeg:dash:23003:3:audio_channel_configuration:2011';

function audioAdaptationSet(index: TrackIndex, reps: RepresentationInfo[]) {
	const pad = '    ';
	// PLAN.md 4.4: audio is never re-encoded for bitrate, so this set holds one
	// Representation and video rung selection can never reach it.
	const attrs = [
		'id="1"',
		'contentType="audio"',
		`mimeType="${esc(reps[0].mimeType)}"`,
		'lang="und"',
		'segmentAlignment="true"',
		'subsegmentAlignment="true"',
		'startWithSAP="1"',
		'subsegmentStartsWithSAP="1"'
	];

	const lines = [`${pad}<AdaptationSet ${attrs.join(' ')}>`];
	lines.push(...segmentTemplate(index, 'audio', `${pad}  `));
	for (const rep of reps) {
		const repAttrs = [
			`id="${int(rep.repId)}"`,
			`codecs="${esc(rep.codec)}"`,
			`bandwidth="${int(rep.bandwidth, 1)}"`
		];
		if (rep.audioSampleRate) repAttrs.push(`audioSamplingRate="${int(rep.audioSampleRate)}"`);
		lines.push(`${pad}  <Representation ${repAttrs.join(' ')}>`);
		lines.push(
			`${pad}    <AudioChannelConfiguration schemeIdUri="${CHANNEL_CONFIG_SCHEME}"` +
				` value="${int(rep.audioChannels ?? 2, 1)}"/>`
		);
		lines.push(`${pad}  </Representation>`);
	}
	lines.push(`${pad}</AdaptationSet>`);
	return lines;
}

/**
 * A static (VOD) MPD over syncstream:// segment URIs.
 *
 * profiles is isoff-live, not isoff-on-demand: the on-demand profile requires a
 * single self-indexed Segment per Representation (SegmentBase + sidx), which is
 * not what we serve. Templated, timeline-indexed segments are the live profile's
 * shape, and type="static" with it is exactly what every packager emits for VOD
 * that is cut into segments.
 */
export function buildMpd(input: ManifestInput, extras: MpdExtras = {}): string {
	const video =
		input.video && input.video.reps.length > 0 && input.video.index.segments.length > 0
			? input.video
			: null;
	const audio =
		input.audio && input.audio.reps.length > 0 && input.audio.index.segments.length > 0
			? input.audio
			: null;

	// The presentation ends where the segments end, which is not what
	// `durationSec` measures. S@t values are absolute media timestamps and there
	// is no pto, so the presentation runs from the first sample's media time to
	// the last one's -- while `durationSec` is a *span*, and its source is either
	// the mvhd (which counts edit lists and the longest track) or a subtraction
	// that already cancelled the start offset out. The two agree only when the
	// first sample sits at zero and every track is the same length.
	//
	// Rendering the span as the duration when they disagree makes Shaka clamp the
	// final segment's end to it, so the tail of the movie is advertised, fetched,
	// and then never played. Measure the timeline we actually emitted instead:
	// the manifest is then internally consistent by construction, which is the
	// one property that cannot be checked from outside this function.
	const timelineEnd = Math.max(
		video ? timelineEndSec(video.index) : 0,
		audio ? timelineEndSec(audio.index) : 0
	);
	const duration = iso8601Duration(timelineEnd > 0 ? timelineEnd : input.durationSec);
	const lines: string[] = [
		'<?xml version="1.0" encoding="utf-8"?>',
		'<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"',
		'  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
		'  xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd"',
		'  type="static"',
		'  profiles="urn:mpeg:dash:profile:isoff-live:2011"',
		`  minBufferTime="${iso8601Duration(SEGMENT_TARGET_SEC)}"`,
		`  mediaPresentationDuration="${duration}">`,
		`  <Period id="0" start="PT0S" duration="${duration}">`
	];

	if (video) lines.push(...videoAdaptationSet(video.index, video.reps, extras));
	if (audio) lines.push(...audioAdaptationSet(audio.index, audio.reps));

	lines.push('  </Period>', '</MPD>', '');
	return lines.join('\n');
}
