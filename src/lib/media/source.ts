/**
 * Host origin: CMAF segments cut from the user's local File on demand
 * (PLAN.md 3, 4.1, Phase 2). This is the inversion the whole plan rests on --
 * the host serves byte ranges of its own disk, and never reads the file whole.
 *
 * Rep 0 (native passthrough) only. The Phase 4 ladder consumes these segments
 * as its encoder input, so the output has to be well-formed fMP4.
 *
 * Approach, and why it is not the obvious one:
 *
 * mp4box's documented segmentation path is `setSegmentOptions({ nbSamples })` +
 * `initializeSegmentation()` + `onSegment()`. We use the first two for init
 * segments and deliberately do NOT use `onSegment` for media segments, because
 * its boundaries are not addressable:
 *
 *  - It cuts where `sampleNum % nb_samples === 0 && sample.is_sync`, an
 *    absolute grid ANDed with the RAP table. There is no nbSamples that lands
 *    that grid on a chosen set of sync samples, so the boundaries are whatever
 *    falls out rather than what the index says.
 *  - `seek()` resets each track's `lastSegmentSampleNumber`, which feeds the
 *    "segment overdue" rule. So segment N reached by seeking has different
 *    boundaries than segment N reached by playing forward. An index that
 *    disagrees with the bytes is worse than no index.
 *  - mp4box 2.x refuses `setSegmentOptions` for a second track whose nbSamples
 *    differs from the first, so a video grid derived from fps and an audio grid
 *    derived from sample rate cannot coexist anyway.
 *
 * So we plan the cut points ourselves off the sample table and call
 * `createFragment(trackId, startSample, endSample)` -- which is the primitive
 * `processSamples` calls underneath, so we are on the same code path, just
 * deciding the boundaries instead of discovering them. That buys exact CMAF
 * alignment (PLAN.md 4.1), audio that tracks the video boundaries, and true
 * random access: segment N is a pure function of N.
 *
 * Random access without re-scanning: the moov's sample table gives every
 * sample's byte offset and size, so a segment's byte range is known before we
 * read anything. We read exactly that range and hand it to the parser, rather
 * than seeking and feeding until the wanted segment falls out.
 *
 * Memory (the hard 500MB-for-2GB budget): nothing retains the file. Per
 * extraction we hold one segment's byte ranges, and we drop them and release
 * the sample data as soon as the fragment is written. The one unavoidable
 * resident cost is the parsed sample table itself, which is the moov, which is
 * the price of admission for seeking at all.
 */

import {
	createFile,
	DataStream,
	MP4BoxBuffer,
	type ISOFile,
	type Movie,
	type Sample
} from 'mp4box';
import {
	NATIVE_REP,
	SEGMENT_CACHE_BYTES,
	SEGMENT_TARGET_SEC,
	type ProbeResult,
	type SegmentEntry,
	type TrackIndex
} from '$lib/media/types';
import { INIT_SEGMENT, segKey, type Track } from '$lib/protocol/control';

/** mp4box does not export the box classes by name; borrow the type off the API. */
type Trak = ReturnType<ISOFile['getTrackById']>;

/** Read granularity while walking boxes looking for the moov. */
const INDEX_READ_BYTES = 1024 * 1024;

/** Tail fallback for moov-at-end files, doubled until the moov is covered. */
const TAIL_START_BYTES = 2 * 1024 * 1024;
const TAIL_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Samples inside a segment are contiguous in a sanely interleaved file, but the
 * other track's bytes sit between them. Merging spans separated by less than
 * this turns a segment into one or two sequential reads instead of hundreds of
 * tiny ones; larger holes are worth skipping rather than reading through.
 */
const READ_GAP_TOLERANCE = 256 * 1024;

export type Source = {
	readonly probe: ProbeResult;
	readonly videoIndex: TrackIndex | null;
	readonly audioIndex: TrackIndex | null;
	readonly durationSec: number;
	/** See `Origin.leadInSec`. */
	readonly leadInSec: number;
	getInit(track: Track): Promise<Uint8Array>;
	getSegment(track: Track, segIdx: number): Promise<Uint8Array>;
	close(): void;
};

/** Inclusive sample range. One segment. */
type SegPlan = { start: number; end: number };

type TrackState = {
	trackId: number;
	trak: Trak;
	samples: Sample[];
	plans: SegPlan[];
	index: TrackIndex;
	init: Uint8Array;
};

/**
 * Serializes extraction. The parser holds mutable per-track cursors and a
 * shared buffer list, so two overlapping extractions would interleave reads
 * into each other's state.
 */
class Mutex {
	#tail: Promise<unknown> = Promise.resolve();

	run<T>(fn: () => Promise<T>): Promise<T> {
		// Both arms run `fn`: a rejected predecessor must not cancel its successor.
		const out = this.#tail.then(fn, fn);
		this.#tail = out.then(
			() => undefined,
			() => undefined
		);
		return out;
	}
}

/** LRU with byte accounting (PLAN.md 7, Phase 2: 200MB cap, regenerate on miss). */
class SegmentCache {
	#map = new Map<string, Uint8Array>();
	#bytes = 0;
	#cap: number;

	constructor(cap: number) {
		this.#cap = cap;
	}

	get(key: string): Uint8Array | undefined {
		const val = this.#map.get(key);
		if (!val) return undefined;
		// Re-insert: Map iterates in insertion order, so this is the recency list.
		this.#map.delete(key);
		this.#map.set(key, val);
		return val;
	}

	put(key: string, val: Uint8Array): void {
		const prev = this.#map.get(key);
		if (prev) {
			this.#bytes -= prev.byteLength;
			this.#map.delete(key);
		}
		// A segment bigger than the whole cap would evict everything else and
		// then sit there alone. Sparse-keyframe files can produce one.
		if (val.byteLength > this.#cap) return;
		this.#map.set(key, val);
		this.#bytes += val.byteLength;
		while (this.#bytes > this.#cap) {
			const oldest = this.#map.keys().next();
			if (oldest.done) break;
			const evicted = this.#map.get(oldest.value);
			this.#map.delete(oldest.value);
			if (evicted) this.#bytes -= evicted.byteLength;
		}
	}

	get bytes(): number {
		return this.#bytes;
	}

	clear(): void {
		this.#map.clear();
		this.#bytes = 0;
	}
}

/**
 * Walks boxes until the moov is parsed. Following the parser's returned
 * position makes a moov-at-end file cost two small reads rather than a scan:
 * once the mdat header is parsed its size is known, so the next parse position
 * is already past it.
 */
async function readMoov(file: File, iso: ISOFile): Promise<Movie> {
	let info: Movie | undefined;
	// Read through a call so control-flow analysis does not narrow away the
	// assignment that happens inside the callback.
	const ready = () => info;
	iso.onReady = (movie) => {
		info = movie;
	};

	let pos = 0;
	while (pos < file.size) {
		const end = Math.min(pos + INDEX_READ_BYTES, file.size);
		const buf = await file.slice(pos, end).arrayBuffer();
		const next = iso.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buf, pos));
		const got = ready();
		if (got) return got;
		pos = next !== undefined && next > pos ? next : end;
	}

	// Files whose mdat size is bogus, or zero meaning "to EOF", never yield a
	// parse position that lands on the trailing moov. Walk the tail back
	// instead. The head read already covered offset 0, so the parser still has
	// the first buffer it needs to stay initialized.
	for (let want = TAIL_START_BYTES; want < file.size * 2 && want <= TAIL_MAX_BYTES; want *= 2) {
		const start = Math.max(0, file.size - want);
		const buf = await file.slice(start, file.size).arrayBuffer();
		iso.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buf, start));
		const got = ready();
		if (got) return got;
	}

	throw new Error(
		'source: no moov box in the head or the last 64MB of the file, so it cannot be segmented'
	);
}

/**
 * Cuts video at sync samples near the target. Taking the first RAP at or after
 * the target keeps every segment at least SEGMENT_TARGET_SEC; snapping to the
 * nearest RAP instead would emit runt segments on long-GOP files, and a runt
 * segment is a wasted round trip.
 *
 * A file with very sparse keyframes gets correspondingly long segments. That is
 * the honest outcome for passthrough: cutting mid-GOP to hit a size target
 * would break seeking and rung switching, which is exactly what PLAN.md 4.1
 * forbids. Phase 4's transcode path cannot fix such a file either -- encoded
 * rungs share this grid -- so the probe rejects it before it gets here once
 * the gap passes MAX_RAP_GAP_SEC (probe.ts).
 */
function planByRap(samples: Sample[], targetTicks: number): SegPlan[] {
	const plans: SegPlan[] = [];
	let start = 0;
	while (start < samples.length) {
		const boundary = samples[start].dts + targetTicks;
		let next = -1;
		// `start` advances to `next` each round, so this scan is linear overall.
		for (let i = start + 1; i < samples.length; i++) {
			if (samples[i].is_sync && samples[i].dts >= boundary) {
				next = i;
				break;
			}
		}
		if (next === -1) {
			plans.push({ start, end: samples.length - 1 });
			break;
		}
		plans.push({ start, end: next - 1 });
		start = next;
	}
	return plans;
}

/**
 * Cuts a track at the given decode times, snapping to the first sample at or
 * after each one. Audio frames are ~23ms, so audio lands within one frame of
 * the video boundary, which is as close as the frame grid allows.
 */
function planBySplits(samples: Sample[], splits: number[]): SegPlan[] {
	const plans: SegPlan[] = [];
	let start = 0;
	let cursor = 1;
	for (const split of splits) {
		let next = -1;
		for (let i = cursor; i < samples.length; i++) {
			if (samples[i].dts >= split) {
				next = i;
				break;
			}
		}
		if (next === -1) break; // track ends before this boundary
		cursor = next + 1;
		if (next <= start) continue; // boundary too close to advance a frame
		plans.push({ start, end: next - 1 });
		start = next;
	}
	plans.push({ start, end: samples.length - 1 });
	return plans;
}

/**
 * Where the last frame to be *shown* ends, in media time. Not `sampleEnd`,
 * which is where the last one to be *decoded* does: with B-frames those are
 * different samples, and the presentation runs on past the final decode time
 * by the reorder delay.
 */
function presentationEnd(samples: Sample[]): number {
	let end = 0;
	for (const s of samples) end = Math.max(end, s.cts + s.duration);
	return end;
}

function sampleEnd(samples: Sample[]): number {
	const last = samples[samples.length - 1];
	return last.dts + last.duration;
}

type Edit = { offset: number; durationSec: number | null };

/** A track with no edit list: nothing to honour, and nothing to take out. */
const NO_EDIT: Edit = { offset: 0, durationSec: null };

/**
 * What a track's edit list asks of a player, reduced to the one shape worth
 * honouring: "start `offset` in, and play for this long".
 *
 * That is every edit list an encoder or a trim tool writes in practice - the
 * few frames of B-frame reorder delay or AAC priming on nearly every file,
 * and the whole trim on a file cut without re-encoding. A leading empty edit
 * (a track that starts late) is folded in where it can be: it moves the start
 * the other way, and a start before the first sample is not something a
 * presentationTimeOffset can state, so that case reads as no offset.
 *
 * Anything else - several media edits, a rate other than 1 - is a timeline
 * that a segment index cannot express at all. That is `null`, which is not the
 * same answer as "no edit": the caller leaves such a track's edit list where
 * it found it, so a browser that reads edit lists still can.
 */
function readEdit(trak: NonNullable<Trak>, movieTimescale: number): Edit | null {
	const entries = trak.edts?.elst?.entries ?? [];
	if (entries.length === 0) return NO_EDIT;
	const timescale = trak.mdia.mdhd.timescale;
	let delay = 0;
	let i = 0;
	while (i < entries.length && entries[i].media_time === -1) {
		delay += entries[i].segment_duration;
		i++;
	}
	const edit = entries[i];
	if (!edit || i + 1 !== entries.length) return null;
	if (edit.media_rate_integer !== 1 || edit.media_rate_fraction !== 0) return null;
	if (movieTimescale <= 0) return null;

	const offset = edit.media_time - Math.round((delay * timescale) / movieTimescale);
	if (offset < 0) return null;
	return {
		offset,
		durationSec: edit.segment_duration > 0 ? edit.segment_duration / movieTimescale : null
	};
}

/**
 * How far before the edit's start the stream has to begin, in the track's own
 * units, so that the frame the edit starts on can be decoded at all.
 *
 * An edit may start anywhere, and a decoder can only start at a keyframe.
 * A <video> playing the file deals with that itself: it decodes from the
 * keyframe and shows nothing until the edit's start. A segmented stream has
 * no such option - everything before the start of its timeline is discarded
 * on append, and a discarded keyframe takes its whole GOP with it, so a film
 * whose edit begins two frames in loses its first ten seconds of picture.
 * (That is not hypothetical: it is how an x265 Blu-ray rip is laid out, and
 * it is what a browser that applies the edit list itself was doing to it.)
 *
 * So the stream's timeline starts at the keyframe instead, this much earlier
 * than the host's, and the host accounts for the difference (`leadInSec`).
 * Zero on most files, where the edit starts exactly on the first frame.
 */
function leadIn(samples: Sample[], offset: number): number {
	let keyframe = -1;
	for (const s of samples) {
		if (s.is_sync && s.cts <= offset && s.cts > keyframe) keyframe = s.cts;
	}
	// No keyframe at or before the start means the track simply begins late,
	// and there is nothing ahead of the edit to keep.
	return keyframe < 0 ? 0 : offset - keyframe;
}

const BOX_HEADER_BYTES = 8;

/** The direct children of the box body spanning [from, to), as type and extent. */
function childBoxes(
	bytes: Uint8Array,
	from: number,
	to: number
): { type: string; start: number; end: number }[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const out: { type: string; start: number; end: number }[] = [];
	let at = from;
	while (at + BOX_HEADER_BYTES <= to) {
		const size = view.getUint32(at);
		// A 64-bit or to-end-of-file size never appears inside an init segment's
		// moov; stop rather than misread one.
		if (size < BOX_HEADER_BYTES || at + size > to) break;
		const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
		out.push({ type, start: at, end: at + size });
		at += size;
	}
	return out;
}

/**
 * Takes the edit list out of an init segment, by retitling its box `free`.
 *
 * The edit is stated once, in the manifest, as a presentationTimeOffset. Left
 * in the init segment as well it is applied twice on a browser whose MSE reads
 * edit lists (Chromium's does) and once on a browser whose MSE does not, and
 * neither total is something the manifest can be written to match. Without it
 * every browser sees the same raw sample times and the manifest alone says
 * where zero is - which is also all the encoded rungs ever had, since their
 * init segments are built from scratch and never carried an edit.
 *
 * Retitled rather than removed so no size field in the moov has to change.
 */
function withoutEditList(init: Uint8Array): Uint8Array {
	const out = init.slice();
	for (const moov of childBoxes(out, 0, out.byteLength)) {
		if (moov.type !== 'moov') continue;
		for (const trak of childBoxes(out, moov.start + BOX_HEADER_BYTES, moov.end)) {
			if (trak.type !== 'trak') continue;
			for (const box of childBoxes(out, trak.start + BOX_HEADER_BYTES, trak.end)) {
				if (box.type === 'edts') out.set([0x66, 0x72, 0x65, 0x65], box.start + 4); // 'free'
			}
		}
	}
	return out;
}

function buildIndex(
	track: Track,
	timescale: number,
	samples: Sample[],
	plans: SegPlan[],
	edit: Edit
): TrackIndex {
	const end = sampleEnd(samples);
	const segments: SegmentEntry[] = plans.map((plan, i) => {
		const time = samples[plan.start].dts;
		const until = i + 1 < plans.length ? samples[plans[i + 1].start].dts : end;
		return { index: i, time, duration: until - time };
	});
	return {
		track,
		timescale,
		durationSec: (end - samples[0].dts) / timescale,
		presentationOffset: edit.offset,
		presentationEnd: presentationEnd(samples),
		presentationDurationSec: edit.durationSec,
		segments
	};
}

/**
 * Byte ranges covering samples [from, to]. Offsets ascend within a track in
 * every sane file, but we sort rather than assume: a mangled stsc/stco pairing
 * must produce a short read we notice, not silent corruption.
 */
function readRanges(samples: Sample[], from: number, to: number): { start: number; end: number }[] {
	const spans: { start: number; end: number }[] = [];
	for (let i = from; i <= to; i++) {
		spans.push({ start: samples[i].offset, end: samples[i].offset + samples[i].size });
	}
	spans.sort((a, b) => a.start - b.start);

	const merged: { start: number; end: number }[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && span.start - last.end <= READ_GAP_TOLERANCE) {
			last.end = Math.max(last.end, span.end);
		} else {
			merged.push({ ...span });
		}
	}
	return merged;
}

export async function createSource(file: File, probe: ProbeResult): Promise<Source> {
	const iso = createFile(false); // discard mdat payloads: we feed sample bytes ourselves
	const info = await readMoov(file, iso);

	if (info.isFragmented) {
		// A fragmented input builds its sample table from moofs as they arrive,
		// so there is no complete index to plan against without reading the
		// whole file -- the one thing this module exists not to do.
		throw new Error(
			'source: this file is already fragmented (fMP4), which the passthrough origin cannot index'
		);
	}

	const videoTrack = info.videoTracks[0];
	const audioTrack = info.audioTracks[0];
	if (!videoTrack && !audioTrack) {
		throw new Error('source: the file has no video or audio track to segment');
	}

	const videoTrak = videoTrack ? iso.getTrackById(videoTrack.id) : undefined;
	const audioTrak = audioTrack ? iso.getTrackById(audioTrack.id) : undefined;
	const videoSamples = videoTrak?.samples ?? [];
	const audioSamples = audioTrak?.samples ?? [];

	if (videoTrak && videoSamples.length === 0) {
		throw new Error('source: the video track has an empty sample table');
	}
	if (audioTrak && audioSamples.length === 0) {
		throw new Error('source: the audio track has an empty sample table');
	}

	// Read before segmentation for the same reason the plans are made first:
	// what initializeSegmentation() leaves of the traks is not ours to rely on.
	const videoEdit = videoTrak ? readEdit(videoTrak, info.timescale) : NO_EDIT;
	const audioEdit = audioTrak ? readEdit(audioTrak, info.timescale) : NO_EDIT;

	// One lead-in for the whole stream, set by whichever track has keyframes to
	// respect: video if there is any, since every audio sample is one.
	const leadTrak = videoTrak ?? audioTrak;
	const leadEdit = videoTrak ? videoEdit : audioEdit;
	const leadInSec =
		leadTrak && leadEdit
			? leadIn(leadTrak.samples, leadEdit.offset) / leadTrak.mdia.mdhd.timescale
			: 0;

	/**
	 * A track's edit as the stream states it: starting `leadInSec` early, and
	 * so running that much longer. Audio cannot always start as early as video
	 * needs it to - it may not have that much before its own edit - and then it
	 * starts where its samples do, which leaves it leading the picture by the
	 * shortfall. That is tens of milliseconds on the files that do it, and the
	 * alternative is the lost GOP.
	 */
	const streamEdit = (edit: Edit | null, timescale: number): Edit => {
		if (!edit) return NO_EDIT;
		return {
			offset: Math.max(0, edit.offset - Math.round(leadInSec * timescale)),
			durationSec: edit.durationSec === null ? null : edit.durationSec + leadInSec
		};
	};

	// Plan before touching segmentation: initializeSegmentation() calls
	// resetTables(), which strips stss and the rest of the sample tables out of
	// the moov so the init segment does not carry them.
	//
	// `is_sync` on each sample is mp4box's parse of stss, and it is already true
	// for every sample when the track has no stss -- an all-intra track where
	// any boundary is legal, which is the behaviour we want anyway.
	const videoPlans = videoTrak
		? planByRap(videoSamples, SEGMENT_TARGET_SEC * videoTrak.mdia.mdhd.timescale)
		: [];

	let audioPlans: SegPlan[] = [];
	if (audioTrak) {
		const audioTimescale = audioTrak.mdia.mdhd.timescale;
		const splits: number[] = [];
		if (videoTrak) {
			const videoTimescale = videoTrak.mdia.mdhd.timescale;
			for (let i = 1; i < videoPlans.length; i++) {
				const dts = videoSamples[videoPlans[i].start].dts;
				splits.push(Math.round((dts * audioTimescale) / videoTimescale));
			}
		}
		// Audio outlasting the last video boundary (or a file with no video at
		// all) keeps cutting on the plain target grid, so the tail does not
		// become one enormous segment.
		//
		// A split is only worth taking if a whole segment's worth of audio follows
		// it; otherwise the remainder just extends the last segment. Cutting on
		// `t < audioEnd` instead splits whenever *any* audio follows, and audio
		// routinely outruns the final video boundary by a frame or two, so the
		// common case -- audio and video of the same length -- ended in a ~10ms
		// segment of its own. That is a whole extra round trip and an extra
		// timeline entry for one AAC frame, and it is the same runt that planByRap
		// is careful not to emit on the video side.
		const audioEnd = sampleEnd(audioSamples);
		const step = SEGMENT_TARGET_SEC * audioTimescale;
		for (
			let t = (splits[splits.length - 1] ?? audioSamples[0].dts) + step;
			audioEnd - t >= step;
			t += step
		) {
			splits.push(t);
		}
		audioPlans = planBySplits(audioSamples, splits);
	}

	// Registering the tracks is what gives initializeSegmentation() something to
	// emit. nbSamples is inert for us because we never call start() and drive
	// createFragment directly, but it is still derived honestly from fps so the
	// registration says what we mean; mp4box 2.x also requires every fragmented
	// track to share one nbSamples, which is why audio gets the same number.
	const fps =
		probe.video && probe.video.fps > 0
			? probe.video.fps
			: videoTrak
				? videoSamples.length / (sampleEnd(videoSamples) / videoTrak.mdia.mdhd.timescale)
				: 0;
	const nbSamples = Math.max(1, Math.round(SEGMENT_TARGET_SEC * fps) || 1);
	if (videoTrack) iso.setSegmentOptions(videoTrack.id, null, { nbSamples, rapAlignement: true });
	if (audioTrack) iso.setSegmentOptions(audioTrack.id, null, { nbSamples, rapAlignement: true });

	const inits = iso.initializeSegmentation('per-track');
	const initFor = (id: number): Uint8Array => {
		const found = inits.find((entry) => entry.id === id);
		if (!found) throw new Error(`source: mp4box produced no init segment for track ${id}`);
		return new Uint8Array(found.buffer);
	};
	/** The edit goes into the manifest or stays in the init segment, never both. */
	const initWith = (id: number, edit: Edit | null): Uint8Array =>
		edit ? withoutEditList(initFor(id)) : initFor(id);

	const states: Partial<Record<Track, TrackState>> = {};
	if (videoTrack && videoTrak) {
		states.video = {
			trackId: videoTrack.id,
			trak: videoTrak,
			samples: videoSamples,
			plans: videoPlans,
			index: buildIndex(
				'video',
				videoTrak.mdia.mdhd.timescale,
				videoSamples,
				videoPlans,
				streamEdit(videoEdit, videoTrak.mdia.mdhd.timescale)
			),
			init: initWith(videoTrack.id, videoEdit)
		};
	}
	if (audioTrack && audioTrak) {
		states.audio = {
			trackId: audioTrack.id,
			trak: audioTrak,
			samples: audioSamples,
			plans: audioPlans,
			index: buildIndex(
				'audio',
				audioTrak.mdia.mdhd.timescale,
				audioSamples,
				audioPlans,
				streamEdit(audioEdit, audioTrak.mdia.mdhd.timescale)
			),
			init: initWith(audioTrack.id, audioEdit)
		};
	}

	// The moov is parsed into boxes now, so the bytes it came from are dead
	// weight -- and the tail path may have read 64MB of them.
	iso.stream.buffers.length = 0;

	const cache = new SegmentCache(SEGMENT_CACHE_BYTES);
	const inflight = new Map<string, Promise<Uint8Array>>();
	const mutex = new Mutex();
	let closed = false;

	const stateFor = (track: Track): TrackState => {
		const state = states[track];
		if (!state) throw new Error(`source: the file has no ${track} track`);
		return state;
	};

	const getInit = async (track: Track): Promise<Uint8Array> => {
		if (closed) throw new Error('source: closed');
		return stateFor(track).init;
	};

	async function extract(track: Track, segIdx: number): Promise<Uint8Array> {
		// close() empties the sample tables, and a job queued behind the mutex when
		// it ran would otherwise index into the emptied array and surface a
		// TypeError to the caller instead of saying the source is closed.
		if (closed) throw new Error('source: closed');

		const state = stateFor(track);
		const plan = state.plans[segIdx];
		if (!plan) {
			throw new Error(
				`source: ${track} segment ${segIdx} is out of range (${state.plans.length} segments)`
			);
		}

		const ranges = readRanges(state.samples, plan.start, plan.end);
		let mdatBytes = 0;
		for (let i = plan.start; i <= plan.end; i++) mdatBytes += state.samples[i].size;

		try {
			// The reads live inside the try because insertBuffer hands the parser a
			// reference it keeps. A slice that rejects part-way through a segment --
			// the file was moved or changed under us, which is a NotReadableError and
			// a real thing to survive when we are serving one file for hours -- would
			// otherwise strand every range already inserted. Nothing addresses those
			// bytes afterwards and nothing else clears them, so failures accumulate
			// toward a resident copy of the whole file: the one thing this module
			// exists not to hold.
			for (const range of ranges) {
				const buf = await file.slice(range.start, range.end).arrayBuffer();
				if (closed) throw new Error('source: closed while reading');
				const mp4buf = MP4BoxBuffer.fromArrayBuffer(buf, range.start);
				// appendBuffer would re-run the box parser over media bytes; we only
				// need the parser to be able to find them, which is insertBuffer's job.
				// usedBytes is what appendBuffer would have zeroed for us.
				mp4buf.usedBytes = 0;
				iso.stream.insertBuffer(mp4buf);
			}

			// createMoof stamps mfhd.sequence_number from a running counter, so a
			// segment's bytes would otherwise depend on how many fragments were
			// built before it: segment 5 made first differs from segment 5 made
			// after 0-4, in exactly one byte. Browsers ignore the field, but
			// PLAN.md 3 content-addresses segments for the Phase 5 mesh, and an
			// LRU miss must regenerate what the hit served. Pin it to the index.
			iso.nextMoofNumber = segIdx;

			// Hand DataStream a buffer that already fits. Left to grow on its own it
			// doubles from zero and full-copies at every step -- five allocations
			// and three copies of a 5MB segment, all of it garbage a moment later.
			// The sample table already told us the exact mdat payload; the rest is
			// a comfortable bound on moof (mfhd+tfhd+tfdt+trun is ~92 + 16 bytes
			// per sample). Underestimating is safe: it just falls back to doubling.
			const capacity = 256 + 20 * (plan.end - plan.start + 1) + 8 + mdatBytes;

			// tfdt.baseMediaDecodeTime comes out as the sample's absolute dts, which
			// is what makes segment N independent of what was produced before it.
			// The declared return type omits it, but this yields undefined when a
			// sample's bytes are missing.
			const stream: DataStream | undefined = iso.createFragment(
				state.trackId,
				plan.start,
				plan.end,
				new DataStream(capacity)
			);
			if (!stream) {
				throw new Error(
					`source: ${track} segment ${segIdx} is missing sample data, so the index disagrees with the file`
				);
			}
			// Slice to what was actually written rather than trusting byteLength:
			// with spare capacity the stream reports the whole buffer, and the tail
			// of it is uninitialized. Correct either way, since an undersized guess
			// leaves the stream exactly full.
			return new Uint8Array(stream.buffer, 0, stream.getPosition()).slice();
		} finally {
			// Both of these are the bounded-memory contract. releaseUsedSamples()
			// is the usual call, but it only walks forward from lastValidSample and
			// we are a random-access origin, so it would silently free nothing
			// after a backwards seek. Release exactly what we allocated instead.
			//
			// Bounded by the live table rather than by the plan: close() may have
			// emptied it while we were reading, and throwing out of a finally would
			// bury the real error. There is nothing left to release in that case --
			// dropping the samples is exactly what close() just did.
			for (let i = plan.start; i <= plan.end && i < state.samples.length; i++) {
				iso.releaseSample(state.trak, i);
			}
			iso.stream.buffers.length = 0;
		}
	}

	return {
		probe,
		videoIndex: states.video?.index ?? null,
		audioIndex: states.audio?.index ?? null,
		leadInSec,
		durationSec:
			probe.durationSec > 0
				? probe.durationSec
				: Math.max(states.video?.index.durationSec ?? 0, states.audio?.index.durationSec ?? 0),

		getInit,

		getSegment(track: Track, segIdx: number): Promise<Uint8Array> {
			if (closed) return Promise.reject(new Error('source: closed'));
			if (segIdx === INIT_SEGMENT) return getInit(track);

			const key = segKey(NATIVE_REP, track, segIdx);
			const hit = cache.get(key);
			if (hit) return Promise.resolve(hit);

			// Two guests asking for the same segment at once is the normal case,
			// not an edge case: one extraction, both callers.
			const pending = inflight.get(key);
			if (pending) return pending;

			const job = mutex
				.run(async () => {
					const cached = cache.get(key);
					if (cached) return cached;
					const bytes = await extract(track, segIdx);
					cache.put(key, bytes);
					return bytes;
				})
				.finally(() => {
					inflight.delete(key);
				});
			inflight.set(key, job);
			return job;
		},

		close(): void {
			closed = true;
			cache.clear();
			inflight.clear();
			iso.stream.buffers.length = 0;
			iso.onReady = undefined;
			// The sample tables are the only large thing left, and the traks hold
			// them; truncating drops them without waiting for the ISOFile to become
			// unreachable.
			for (const state of Object.values(states)) state.samples.length = 0;
		}
	};
}
