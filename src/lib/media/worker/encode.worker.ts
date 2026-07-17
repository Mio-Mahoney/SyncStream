/**
 * WebCodecs transcode worker (PLAN.md 4.4, 4.5, and 4.3 tier 2; Phase 4).
 *
 * The input is rep 0's own CMAF segment, never the user's file. Feeding rep 0's
 * segment N through decode -> encode -> mux to produce rung R's segment N gives
 * the CMAF contract of PLAN.md 4.1 by construction: identical boundaries,
 * identical timescale, keyframe aligned, because rep 0 already is. Every timing
 * decision below is therefore read out of the input bytes rather than passed in
 * beside them -- an index handed in alongside would be a second source of truth
 * and the two would drift. It also means the user's file is parsed exactly once,
 * by source.ts, and never again here.
 *
 * WebCodecs resource discipline: every VideoFrame and AudioData is closed on
 * every path, including error paths. A leaked frame holds a slot in the GPU
 * decode pool, and an exhausted pool wedges the encoder for the rest of the
 * session -- on a machine that is also playing the movie back.
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { createFile, Log, MP4BoxBuffer, type Sample } from 'mp4box';
import type { Track } from '$lib/protocol/control';

/** AAC-LC codes exactly 1024 samples per frame. The audio grid below depends on it. */
export const AAC_FRAME_SAMPLES = 1024;

/**
 * mp4-muxer starts a new fragment at any keyframe once the current one is at
 * least this long. One moof per CMAF segment is what we want, so the threshold
 * is set past any plausible segment duration. It must stay finite: the muxer
 * rejects a non-finite value.
 */
const NO_FRAGMENT_SPLIT_SEC = 1e9;

/** max_num_reorder_frames is capped at 16 by both H.264 and HEVC. */
const MAX_REORDER_DEPTH = 16;

export type VideoJobSpec = {
	kind: 'video';
	/** Already validated with VideoEncoder.isConfigSupported() on the main thread. */
	encoder: VideoEncoderConfig;
	decoder: VideoDecoderConfig;
};

export type AudioJobSpec = {
	kind: 'audio';
	encoder: AudioEncoderConfig;
	decoder: AudioDecoderConfig;
};

export type JobSpec = VideoJobSpec | AudioJobSpec;

export type EncodeRequest = {
	t: 'encode';
	jobId: number;
	track: Track;
	/** Rep 0's init segment for this track: ftyp + moov, as source.ts produced it. */
	init: Uint8Array;
	/** Rep 0's media segment (moof + mdat) for the segment being produced. */
	seg: Uint8Array;
	/**
	 * Audio only, and optional at EOF: rep 0's *next* segment. The AAC frame grid
	 * does not divide the source segment boundary evenly, so the last frame of
	 * this segment straddles it and needs the first few samples of the next one.
	 */
	next?: Uint8Array;
	spec: JobSpec;
};

export type EncodeOk = {
	t: 'ok';
	jobId: number;
	/** ftyp + moov for this rung. Identical for every segment of the rung. */
	init: Uint8Array;
	/** moof + mdat, tfdt aligned to rep 0. */
	seg: Uint8Array;
};

export type EncodeErr = { t: 'err'; jobId: number; error: string };

export type EncodeResponse = EncodeOk | EncodeErr;

Log.setLogLevel(Log.error);

/** `self` types as a Window under lib.dom, which has a different postMessage. */
const ctx = self as unknown as {
	onmessage: ((ev: MessageEvent<EncodeRequest>) => void) | null;
	postMessage(message: EncodeResponse, transfer?: Transferable[]): void;
};

ctx.onmessage = (ev: MessageEvent<EncodeRequest>) => {
	const req = ev.data;
	if (!req || req.t !== 'encode') return;
	void run(req);
};

async function run(req: EncodeRequest): Promise<void> {
	try {
		const out =
			req.spec.kind === 'video'
				? await transcodeVideo(req, req.spec)
				: await transcodeAudio(req, req.spec);
		const res: EncodeOk = { t: 'ok', jobId: req.jobId, init: out.init, seg: out.seg };
		// The worker owns these buffers, so handing them over rather than copying
		// them is safe. The request's buffers are never transferred: they are
		// source.ts's cached rep 0 bytes and detaching them would gut its LRU.
		ctx.postMessage(res, [out.init.buffer as ArrayBuffer, out.seg.buffer as ArrayBuffer]);
	} catch (err) {
		const res: EncodeErr = { t: 'err', jobId: req.jobId, error: messageOf(err) };
		ctx.postMessage(res);
	}
}

/* ---------------------------------------------------------------- video --- */

async function transcodeVideo(
	req: EncodeRequest,
	spec: VideoJobSpec
): Promise<{ init: Uint8Array; seg: Uint8Array }> {
	const { samples, timescale } = demux(req.init, [req.seg], 'video');
	if (samples.length === 0) throw new Error('rep 0 video segment contains no samples');

	// The re-encode carries no B-frames, so its decode order is its presentation
	// order and the segment starts at the first frame the decoder actually
	// presents. Rep 0's own tfdt is its first *decode* time, which sits earlier by
	// the composition offset when the source has B-frames; presentation time is
	// what MSE splices on, so presentation start is what has to match. Keeping the
	// exact source unit for each microsecond timestamp avoids reintroducing a
	// rounding error on the way back out.
	const ctsByUs = new Map<number, number>();
	let defaultDurUs = 0;
	for (const s of samples) {
		ctsByUs.set(toMicros(s.cts, timescale), s.cts);
		if (defaultDurUs === 0) defaultDurUs = toMicros(s.duration, timescale);
	}

	const width = spec.encoder.width;
	const height = spec.encoder.height;

	const muxer = new Muxer({
		target: new ArrayBufferTarget(),
		// mp4-muxer derives the track's timescale from `frameRate`, and rep 0's own
		// timescale is the only legal value here (PLAN.md 4.1). It is not a frame
		// rate claim; it is the only lever the library exposes over the timescale.
		video: { codec: 'avc', width, height, frameRate: timescale },
		fastStart: 'fragmented',
		// Rebase to zero here and patch tfdt to rep 0's presentation start below.
		// That is exact whatever absolute timestamps the encoder chooses to emit,
		// where 'strict' would simply reject every segment after the first.
		firstTimestampBehavior: 'offset',
		minFragmentDuration: NO_FRAGMENT_SPLIT_SEC
	});

	const errors: Error[] = [];
	let canvas: OffscreenCanvas | null = null;
	let ctx: OffscreenCanvasRenderingContext2D | null = null;
	let framesIn = 0;
	let firstOutUs = -1;

	const encoder = new VideoEncoder({
		output: (chunk, meta) => {
			try {
				const data = new Uint8Array(chunk.byteLength);
				chunk.copyTo(data);
				muxer.addVideoChunkRaw(
					data,
					chunk.type,
					chunk.timestamp,
					chunk.duration ?? defaultDurUs,
					meta,
					0
				);
			} catch (err) {
				errors.push(asError(err));
			}
		},
		error: (err) => errors.push(asError(err))
	});
	encoder.configure(spec.encoder);

	const decoder = new VideoDecoder({
		output: (frame) => {
			let scaled: VideoFrame | null = null;
			try {
				if (framesIn === 0) firstOutUs = frame.timestamp;
				if (needsScale(frame, width, height)) {
					if (!canvas) {
						canvas = new OffscreenCanvas(width, height);
						ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
						if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
					}
					ctx!.drawImage(frame, 0, 0, width, height);
					scaled = new VideoFrame(canvas, {
						timestamp: frame.timestamp,
						duration: frame.duration ?? defaultDurUs,
						alpha: 'discard'
					});
				}
				// The first frame of a segment must be an IDR or the segment is not
				// independently decodable and rung switching breaks.
				encoder.encode(scaled ?? frame, { keyFrame: framesIn === 0 });
				framesIn++;
			} catch (err) {
				errors.push(asError(err));
			} finally {
				scaled?.close();
				frame.close();
			}
		},
		error: (err) => errors.push(asError(err))
	});
	decoder.configure(spec.decoder);

	try {
		for (const s of samples) {
			if (!s.data) throw new Error('mp4box returned a video sample with no data');
			decoder.decode(
				new EncodedVideoChunk({
					type: s.is_sync ? 'key' : 'delta',
					timestamp: toMicros(s.cts, timescale),
					duration: toMicros(s.duration, timescale),
					data: s.data
				})
			);
		}
		await decoder.flush();
		await encoder.flush();
	} finally {
		if (decoder.state !== 'closed') decoder.close();
		if (encoder.state !== 'closed') encoder.close();
	}

	if (errors.length > 0) throw errors[0];
	if (framesIn === 0) throw new Error('decoder produced no frames');
	// A segment that opens on a CRA rather than an IDR has leading pictures that
	// reference the previous GOP, and the decoder correctly drops them. That costs
	// a few frames off the front, which the tfdt below accounts for exactly.
	// Losing more than the codec's own reorder bound is not that: it is a broken
	// decode, and a rung with holes in it is worse than no rung at all.
	if (samples.length - framesIn > MAX_REORDER_DEPTH) {
		throw new Error(`decoded only ${framesIn} of ${samples.length} frames`);
	}

	muxer.finalize();
	const parts = splitInitAndMedia(new Uint8Array(muxer.target.buffer));
	patchBaseMediaDecodeTime(
		parts.seg,
		ctsByUs.get(firstOutUs) ?? Math.round((firstOutUs * timescale) / 1e6)
	);
	return parts;
}

function needsScale(frame: VideoFrame, width: number, height: number): boolean {
	return (
		frame.codedWidth !== width ||
		frame.codedHeight !== height ||
		frame.displayWidth !== width ||
		frame.displayHeight !== height
	);
}

/* ---------------------------------------------------------------- audio --- */

/**
 * PLAN.md 4.4: audio is transcoded for codec reasons only. There is one audio
 * representation and video rung selection never touches it.
 *
 * The hard part is that AAC codes on a fixed 1024-sample grid that does not
 * divide rep 0's segment boundaries. Encoding each segment from its own first
 * sample would restart that grid, and re-prime the encoder, at every boundary:
 * an audible tick every four seconds forever. So the grid is defined globally
 * from sample zero, and segment N owns frames [ceil(start/1024), ceil(end/1024)).
 * Consecutive segments then tile the timeline exactly -- segment N+1's first
 * frame is segment N's last frame plus one -- with no gap, no overlap and no
 * partial frame, while each segment is still encodable on its own from rep 0's
 * segment N plus the first frame or so of segment N+1.
 */
async function transcodeAudio(
	req: EncodeRequest,
	spec: AudioJobSpec
): Promise<{ init: Uint8Array; seg: Uint8Array }> {
	const segs = req.next ? [req.seg, req.next] : [req.seg];
	const { samples, timescale } = demux(req.init, segs, 'audio');
	if (samples.length === 0) throw new Error('rep 0 audio segment contains no samples');

	const rate = spec.encoder.sampleRate;
	const segStart = readBaseMediaDecodeTime(req.seg);
	const segEnd = req.next
		? readBaseMediaDecodeTime(req.next)
		: samples[samples.length - 1].dts + samples[samples.length - 1].duration;

	// Absolute output-sample indices. tfdt and the encoder's clock agree because
	// mp4-muxer forces the audio track's timescale to the sample rate.
	const startSample = Math.round((segStart * rate) / timescale);
	const endSample = Math.round((segEnd * rate) / timescale);
	const gridStart = Math.ceil(startSample / AAC_FRAME_SAMPLES) * AAC_FRAME_SAMPLES;
	const gridEnd = Math.ceil(endSample / AAC_FRAME_SAMPLES) * AAC_FRAME_SAMPLES;
	const frames = gridEnd - gridStart;
	if (frames <= 0) throw new Error('audio segment is shorter than one AAC frame');

	const errors: Error[] = [];
	let srcChannels = 0;
	let planes: Float32Array<ArrayBuffer> | null = null;

	const decoder = new AudioDecoder({
		output: (data) => {
			try {
				if (data.sampleRate !== rate) {
					throw new Error(
						`decoder emitted ${data.sampleRate} Hz but the encoder is configured for ${rate} Hz; no resampler exists in this path`
					);
				}
				if (!planes) {
					srcChannels = data.numberOfChannels;
					planes = new Float32Array(srcChannels * frames);
				}
				collect(data, planes, srcChannels, frames, gridStart, rate);
			} catch (err) {
				errors.push(asError(err));
			} finally {
				data.close();
			}
		},
		error: (err) => errors.push(asError(err))
	});
	decoder.configure(spec.decoder);

	try {
		for (const s of samples) {
			if (!s.data) throw new Error('mp4box returned an audio sample with no data');
			// Everything from rep 0's own segment, plus only as much of the next
			// segment as the straddling frame needs.
			if (Math.round((s.dts * rate) / timescale) >= gridEnd) break;
			decoder.decode(
				new EncodedAudioChunk({
					type: s.is_sync ? 'key' : 'delta',
					timestamp: toMicros(s.cts, timescale),
					duration: toMicros(s.duration, timescale),
					data: s.data
				})
			);
		}
		await decoder.flush();
	} finally {
		if (decoder.state !== 'closed') decoder.close();
	}
	if (errors.length > 0) throw errors[0];
	if (!planes) throw new Error('audio decoder produced no data');

	const outChannels = spec.encoder.numberOfChannels;
	const mixed = downmix(planes, srcChannels, outChannels, frames);

	const muxer = new Muxer({
		target: new ArrayBufferTarget(),
		audio: { codec: 'aac', numberOfChannels: outChannels, sampleRate: rate },
		fastStart: 'fragmented',
		firstTimestampBehavior: 'offset',
		minFragmentDuration: NO_FRAGMENT_SPLIT_SEC
	});

	const frameDurUs = Math.round((AAC_FRAME_SAMPLES * 1e6) / rate);
	const encoder = new AudioEncoder({
		output: (chunk, meta) => {
			try {
				const data = new Uint8Array(chunk.byteLength);
				chunk.copyTo(data);
				muxer.addAudioChunkRaw(
					data,
					chunk.type,
					chunk.timestamp,
					chunk.duration ?? frameDurUs,
					meta
				);
			} catch (err) {
				errors.push(asError(err));
			}
		},
		error: (err) => errors.push(asError(err))
	});
	encoder.configure(spec.encoder);

	// One AudioData starting exactly on the grid: the encoder blocks it into
	// 1024-sample frames from that offset, which is what puts the output frames
	// back on the global grid.
	const input = new AudioData({
		format: 'f32-planar',
		sampleRate: rate,
		numberOfChannels: outChannels,
		numberOfFrames: frames,
		timestamp: toMicros(gridStart, rate),
		data: mixed
	});
	try {
		encoder.encode(input);
		await encoder.flush();
	} finally {
		input.close();
		if (encoder.state !== 'closed') encoder.close();
	}
	if (errors.length > 0) throw errors[0];

	muxer.finalize();
	const parts = splitInitAndMedia(new Uint8Array(muxer.target.buffer));
	patchBaseMediaDecodeTime(parts.seg, gridStart);
	return parts;
}

/** Copies the part of `data` that lands inside the segment's grid window. */
function collect(
	data: AudioData,
	planes: Float32Array<ArrayBuffer>,
	channels: number,
	frames: number,
	gridStart: number,
	rate: number
): void {
	const at = Math.round((data.timestamp * rate) / 1e6);
	const from = Math.max(gridStart, at);
	const to = Math.min(gridStart + frames, at + data.numberOfFrames);
	if (to <= from) return;
	const frameOffset = from - at;
	const frameCount = to - from;
	const dst = from - gridStart;
	for (let ch = 0; ch < channels; ch++) {
		data.copyTo(planes.subarray(ch * frames + dst, ch * frames + dst + frameCount), {
			planeIndex: ch,
			format: 'f32-planar',
			frameOffset,
			frameCount
		});
	}
}

/**
 * Windows' AAC encoder is stereo-only, so a 5.1 source has to be folded down or
 * the file is rejected on that machine for no reason the viewer can act on
 * (PLAN.md 4.3). Coefficients are ITU-R BS.775, normalised rather than clipped:
 * a little quiet beats intermodulation on every loud scene.
 */
function downmix(
	planes: Float32Array<ArrayBuffer>,
	srcChannels: number,
	outChannels: number,
	frames: number
): Float32Array<ArrayBuffer> {
	if (srcChannels === outChannels) return planes;
	const out = new Float32Array(outChannels * frames);
	const plane = (ch: number) => planes.subarray(ch * frames, ch * frames + frames);

	if (outChannels === 2 && (srcChannels === 6 || srcChannels === 8)) {
		// MP4 channel order for 5.1 and 7.1: L R C LFE Ls Rs [Lb Rb]. LFE is dropped.
		const C = 0.707;
		const norm = 1 / (1 + C + C);
		const l = plane(0);
		const r = plane(1);
		const c = plane(2);
		const ls = plane(4);
		const rs = plane(5);
		const left = out.subarray(0, frames);
		const right = out.subarray(frames, 2 * frames);
		for (let i = 0; i < frames; i++) {
			left[i] = (l[i] + C * c[i] + C * ls[i]) * norm;
			right[i] = (r[i] + C * c[i] + C * rs[i]) * norm;
		}
		return out;
	}

	if (outChannels === 1) {
		const mono = out.subarray(0, frames);
		for (let ch = 0; ch < srcChannels; ch++) {
			const src = plane(ch);
			for (let i = 0; i < frames; i++) mono[i] += src[i] / srcChannels;
		}
		return out;
	}

	// Unknown layout: fold every source channel into every output channel evenly.
	// Never correct for a specific layout, never wrong enough to be silent.
	for (let ch = 0; ch < outChannels; ch++) {
		const dst = out.subarray(ch * frames, ch * frames + frames);
		if (srcChannels < outChannels) {
			// Fewer sources than sinks -- a mono source on a machine whose AAC encoder
			// would only take stereo. Striding by outChannels from `ch` finds no source
			// at all for ch >= srcChannels, which is a silent channel and not a
			// downmix. Wrap instead: duplicated beats absent.
			const from = plane(ch % srcChannels);
			for (let i = 0; i < frames; i++) dst[i] = from[i];
			continue;
		}
		for (let src = ch; src < srcChannels; src += outChannels) {
			const from = plane(src);
			const n = Math.ceil((srcChannels - ch) / outChannels);
			for (let i = 0; i < frames; i++) dst[i] += from[i] / n;
		}
	}
	return out;
}

/* ---------------------------------------------------------------- demux --- */

type Demuxed = { samples: Sample[]; timescale: number };

/**
 * Parses rep 0's init plus one or more of its media segments back into samples.
 * The segments are appended at their real file offsets so mp4box sees one
 * contiguous stream, which is exactly what they are.
 */
function demux(init: Uint8Array, segs: Uint8Array[], kind: Track): Demuxed {
	const file = createFile(true);
	const samples: Sample[] = [];
	let trackId = -1;
	let timescale = 0;
	let parseError: string | null = null;

	file.onError = (module, message) => {
		parseError = `${module}: ${message}`;
	};
	file.onReady = (info) => {
		const track = (kind === 'video' ? info.videoTracks : info.audioTracks)[0];
		if (!track) return;
		trackId = track.id;
		timescale = track.timescale;
		file.setExtractionOptions(trackId, null, { nbSamples: Number.MAX_SAFE_INTEGER });
		file.start();
	};
	file.onSamples = (id, _user, batch) => {
		if (id !== trackId) return;
		for (const s of batch) samples.push(s);
	};

	file.appendBuffer(toMP4BoxBuffer(init, 0));
	let at = init.byteLength;
	for (const seg of segs) {
		file.appendBuffer(toMP4BoxBuffer(seg, at));
		at += seg.byteLength;
	}
	file.flush();

	if (parseError) throw new Error(`mp4box could not parse rep 0's segment (${parseError})`);
	if (trackId < 0) throw new Error(`rep 0's init segment declares no ${kind} track`);
	return { samples, timescale };
}

function toMP4BoxBuffer(bytes: Uint8Array, fileStart: number): MP4BoxBuffer {
	const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	return MP4BoxBuffer.fromArrayBuffer(copy, fileStart);
}

/* ----------------------------------------------------------------- boxes --- */

type BoxRef = { type: string; start: number; body: number; end: number };

function boxesIn(bytes: Uint8Array, from: number, to: number): BoxRef[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const boxes: BoxRef[] = [];
	let at = from;
	while (at + 8 <= to) {
		let size = view.getUint32(at);
		let body = at + 8;
		if (size === 1) {
			size = Number(view.getBigUint64(at + 8));
			body = at + 16;
		} else if (size === 0) {
			size = to - at;
		}
		if (size < 8 || at + size > to) break;
		let type = '';
		for (let i = 4; i < 8; i++) type += String.fromCharCode(bytes[at + i]);
		boxes.push({ type, start: at, body, end: at + size });
		at += size;
	}
	return boxes;
}

/**
 * mp4-muxer's fragmented output is ftyp | moov | moof | mdat | mfra. CMAF wants
 * the first two as the representation's init segment and the middle pair as the
 * media segment; mfra is a whole-file random access index and has no place in
 * either.
 */
function splitInitAndMedia(out: Uint8Array): { init: Uint8Array; seg: Uint8Array } {
	const boxes = boxesIn(out, 0, out.byteLength);
	const first = boxes.findIndex((b) => b.type === 'moof');
	if (first < 1) throw new Error('muxer produced no fragment');
	let mediaEnd = boxes[first].end;
	for (let i = first; i < boxes.length; i++) {
		if (boxes[i].type !== 'moof' && boxes[i].type !== 'mdat') break;
		mediaEnd = boxes[i].end;
	}
	return {
		init: out.slice(0, boxes[first - 1].end),
		seg: out.slice(boxes[first].start, mediaEnd)
	};
}

function findTfdt(seg: Uint8Array): BoxRef {
	const moof = boxesIn(seg, 0, seg.byteLength).find((b) => b.type === 'moof');
	if (!moof) throw new Error('segment has no moof');
	const traf = boxesIn(seg, moof.body, moof.end).find((b) => b.type === 'traf');
	if (!traf) throw new Error('segment has no traf');
	const tfdt = boxesIn(seg, traf.body, traf.end).find((b) => b.type === 'tfdt');
	if (!tfdt) throw new Error('segment has no tfdt');
	return tfdt;
}

function readBaseMediaDecodeTime(seg: Uint8Array): number {
	const tfdt = findTfdt(seg);
	const view = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
	const version = view.getUint8(tfdt.body);
	return version === 1 ? Number(view.getBigUint64(tfdt.body + 4)) : view.getUint32(tfdt.body + 4);
}

/**
 * The one number that decides whether a rung switch is seamless. It has to be
 * rep 0's own, in rep 0's timescale, or MSE splices the rung in at the wrong
 * place and glitches on every switch (PLAN.md 4.1).
 */
function patchBaseMediaDecodeTime(seg: Uint8Array, value: number): void {
	const tfdt = findTfdt(seg);
	const view = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
	const version = view.getUint8(tfdt.body);
	if (version === 1) view.setBigUint64(tfdt.body + 4, BigInt(value));
	else view.setUint32(tfdt.body + 4, value);
}

/* ----------------------------------------------------------------- misc --- */

function toMicros(units: number, timescale: number): number {
	return Math.round((units * 1e6) / timescale);
}

function asError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
