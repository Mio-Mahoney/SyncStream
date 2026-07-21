/**
 * ABR ladder (PLAN.md 4.5, 4.4, 4.3 tier 2; Phase 4).
 *
 * Rungs are generated from rep 0's own CMAF segments, never from the user's
 * file: rung R's segment N is rep 0's segment N run through decode -> encode ->
 * mux. That is what makes the PLAN.md 4.1 CMAF contract hold by construction --
 * identical boundaries, identical timescale, keyframe aligned, because rep 0
 * already is -- instead of holding because two independent parsers agreed.
 *
 * Everything here is lazy. A rung that nobody watches costs nothing, which is
 * the whole reason PLAN.md 4.5 can afford a 360p floor.
 */

import type { Track } from '$lib/protocol/control';
import { segKey } from '$lib/protocol/control';
import {
	LADDER,
	NATIVE_REP,
	SEGMENT_CACHE_BYTES,
	SEGMENT_TARGET_SEC,
	type AudioTrackInfo,
	type ProbeResult,
	type RepresentationInfo,
	type Rung,
	type VideoTrackInfo
} from './types';
import type {
	AudioJobSpec,
	EncodeRequest,
	EncodeResponse,
	VideoJobSpec
} from './worker/encode.worker';

/**
 * The half of source.ts the ladder consumes, structurally: rep 0's bytes are the
 * transcoder's input and that is the entire coupling. No segment index, no file
 * handle, no second parse of the user's file.
 */
export type LadderSource = {
	getInit(track: Track): Promise<Uint8Array>;
	getSegment(track: Track, segIdx: number): Promise<Uint8Array>;
};

export type Ladder = {
	/**
	 * Rungs safe to put in the manifest. A rung appears only once its leading
	 * segments are encoded, so Shaka's ABR estimator never reads encode latency
	 * as low throughput and downshifts away from a rung that is actually fine
	 * (PLAN.md 4.2).
	 */
	availableRungs(): number[];
	onRungsChanged(cb: (rungs: number[]) => void): () => void;
	/**
	 * Resolves once encoder support has been probed, which is what fixes the
	 * codec strings in the manifest. Fast (a few isConfigSupported calls); it
	 * does not wait for any encoding. Await it before the first MPD.
	 */
	ready(): Promise<void>;
	/**
	 * What this rep will actually be, once known. Null when the rep does not
	 * exist on this device. The ladder owns this because the ladder is what
	 * picked the encoder config, and the manifest must not guess it.
	 */
	representation(repId: number, track: Track): RepresentationInfo | null;
	getInit(repId: number, track: Track): Promise<Uint8Array>;
	getSegment(repId: number, track: Track, segIdx: number): Promise<Uint8Array>;
	/** This segment is wanted soon. Pre-generates ahead of the playhead. */
	note(repId: number, track: Track, segIdx: number): void;
	close(): void;
};

/** Hardware encoders run well above realtime, so a few segments of lead is enough. */
const LOOKAHEAD_SEGMENTS = 3;

/** How much of a rung must exist before it is advertised (PLAN.md 4.2). */
const WARM_SEGMENTS = 2;

/**
 * Encoded rungs are small next to rep 0's passthrough segments, and rep 0 owns
 * the bulk of SEGMENT_CACHE_BYTES. A quarter of the budget is roughly 40 encoded
 * segments, far more than the working set of a playhead plus its lead.
 */
const ENCODED_CACHE_BYTES = Math.floor(SEGMENT_CACHE_BYTES / 4);

const PRIORITY_DEMAND = 0;
const PRIORITY_WARM = 1;
const PRIORITY_AHEAD = 2;

type Slot = {
	worker: Worker;
	busy: boolean;
	/** The job the worker is answering right now. A reply naming anything else is stale. */
	jobId: number;
	settle: ((res: EncodeResponse) => void) | null;
};

type Job = {
	key: string;
	repId: number;
	track: Track;
	segIdx: number;
	priority: number;
	promise: Promise<Uint8Array>;
	resolve: (bytes: Uint8Array) => void;
	reject: (err: Error) => void;
};

export function createLadder(source: LadderSource, probe: ProbeResult): Ladder {
	const video = probe.video;
	const audio = probe.audio;
	const videoTranscode = probe.videoAction === 'transcode';
	const audioTranscode = probe.audioAction === 'transcode';

	/**
	 * A soft upper bound only. source.ts owns the exact index, and depending on it
	 * here would be the second source of truth this module exists to avoid; all it
	 * buys is not queueing pre-generation past the end of the movie. Inclusive, so
	 * it is the last index and not the count: ceil() is how many segments a
	 * target-length grid holds, and the last of N is N-1.
	 */
	const maxSegIdx = Math.max(0, Math.ceil(probe.durationSec / SEGMENT_TARGET_SEC) - 1);

	const cache = new Map<string, Uint8Array>();
	let cacheBytes = 0;
	const inits = new Map<string, Uint8Array>();
	const sourceInits = new Map<Track, Promise<Uint8Array>>();

	const queue: Job[] = [];
	const pending = new Map<string, Job>();
	const slots: Slot[] = [];
	const maxWorkers = workerBudget();
	let nextJobId = 1;

	const configs = new Map<number, VideoEncoderConfig>();
	let videoDecoderConfig: VideoDecoderConfig | null = null;
	let audioEncoderConfig: AudioEncoderConfig | null = null;
	let audioDecoderConfig: AudioDecoderConfig | null = null;

	let rungs: number[] = [NATIVE_REP];
	const listeners = new Set<(rungs: number[]) => void>();
	let focus = 0;
	let closed = false;

	const readyPromise = resolveConfigs();
	void readyPromise.then(warmUp, () => {});

	/* ------------------------------------------------------------ capability - */

	async function resolveConfigs(): Promise<void> {
		// Feature-detect, never UA-sniff, and never trust a cached claim over the
		// browser's own answer (PLAN.md 4.8). The probe's capability flags say
		// whether to bother asking; isConfigSupported is what actually decides.
		if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return;

		if (video) {
			const dec: VideoDecoderConfig = {
				codec: video.codec,
				description: video.description,
				codedWidth: video.width,
				codedHeight: video.height,
				optimizeForLatency: true
			};
			const decSupport = await VideoDecoder.isConfigSupported(dec).catch(() => null);
			if (decSupport?.supported) {
				videoDecoderConfig = decSupport.config ?? dec;
				for (const rung of LADDER) {
					if (rung.id === NATIVE_REP && !videoTranscode) continue;
					const cfg = await resolveVideoConfig(rung, video);
					if (cfg) configs.set(rung.id, cfg);
				}
			}
		}

		if (audio && audioTranscode && typeof AudioEncoder !== 'undefined') {
			const dec: AudioDecoderConfig = {
				codec: audio.codec,
				description: audio.description,
				numberOfChannels: audio.channels,
				sampleRate: audio.sampleRate
			};
			const decSupport = await AudioDecoder.isConfigSupported(dec).catch(() => null);
			if (decSupport?.supported) {
				audioDecoderConfig = decSupport.config ?? dec;
				audioEncoderConfig = await resolveAudioConfig(audio);
			}
		}
	}

	/* ------------------------------------------------------------- warm-up --- */

	async function warmUp(): Promise<void> {
		// Rep 0 is advertised from the start whatever happens -- it is the only rep
		// ABR cannot switch away from -- but when it is a transcode it still wants
		// a head start, or time-to-first-frame pays for the first encode.
		if (videoTranscode && configs.has(NATIVE_REP)) {
			await request(NATIVE_REP, 'video', focus, PRIORITY_WARM).catch(() => null);
		}
		if (audioTranscode && audioEncoderConfig) {
			await request(NATIVE_REP, 'audio', focus, PRIORITY_WARM).catch(() => null);
		}

		// Top-down: 720p, then 480p, then 360p. Rep 0 is always in the set, so
		// this order makes every advertised set a contiguous prefix of the
		// ladder -- the only shape Shaka's numeric restrictions window can
		// express exactly (applyRungRestrictions in shaka/config.ts). The old
		// order was cheapest-first, to raise the 360p stall floor sooner, but it
		// spent the whole warm-up advertising a set with 720p missing from the
		// middle, and a cold rung inside the window stays selectable: guests
		// downshifted onto rung 1 while the host advertised [0, 2, 3]. An
		// honest advertisement beats an early floor the window cannot state;
		// until the floor arrives, the Phase 3 barrier is what holds a starved
		// guest, which is its job.
		const order = [...configs.keys()].filter((id) => id !== NATIVE_REP).sort((a, b) => a - b);
		for (const rungId of order) {
			if (closed) return;
			const base = focus;
			let leading: Uint8Array | null = null;
			for (let i = 0; i < WARM_SEGMENTS && base + i <= maxSegIdx; i++) {
				const bytes = await request(rungId, 'video', base + i, PRIORITY_WARM).catch(() => null);
				if (i === 0) leading = bytes;
			}
			if (closed) return;
			// A rung whose own leading segment will not encode is not a rung --
			// and advertising anything below it would reopen the very hole this
			// order exists to close, so the ladder ends at the first failure.
			if (!leading) return;
			advertise(rungId);
		}
	}

	function advertise(rungId: number): void {
		if (rungs.includes(rungId)) return;
		rungs = [...rungs, rungId].sort((a, b) => a - b);
		const snapshot = [...rungs];
		for (const cb of listeners) cb(snapshot);
	}

	/* --------------------------------------------------------------- cache --- */

	function cacheGet(key: string): Uint8Array | undefined {
		const hit = cache.get(key);
		if (!hit) return undefined;
		cache.delete(key);
		cache.set(key, hit);
		return hit;
	}

	function cachePut(key: string, bytes: Uint8Array): void {
		const old = cache.get(key);
		if (old) {
			cache.delete(key);
			cacheBytes -= old.byteLength;
		}
		cache.set(key, bytes);
		cacheBytes += bytes.byteLength;
		for (const [k, v] of cache) {
			if (cacheBytes <= ENCODED_CACHE_BYTES) break;
			if (k === key) continue;
			cache.delete(k);
			cacheBytes -= v.byteLength;
		}
	}

	/* --------------------------------------------------------------- queue --- */

	function request(
		repId: number,
		track: Track,
		segIdx: number,
		priority: number
	): Promise<Uint8Array> {
		if (closed) return Promise.reject(new Error('ladder is closed'));
		const key = segKey(repId, track, segIdx);
		const hit = cacheGet(key);
		if (hit) return Promise.resolve(hit);

		const existing = pending.get(key);
		if (existing) {
			// A segment somebody is now waiting on outranks the same segment queued
			// as a guess about the future.
			existing.priority = Math.min(existing.priority, priority);
			return existing.promise;
		}

		let resolve!: (bytes: Uint8Array) => void;
		let reject!: (err: Error) => void;
		const promise = new Promise<Uint8Array>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		const job: Job = { key, repId, track, segIdx, priority, promise, resolve, reject };
		pending.set(key, job);
		queue.push(job);
		pump();
		return promise;
	}

	function pump(): void {
		while (!closed && queue.length > 0) {
			const slot = acquire();
			if (!slot) return;
			// Soonest-needed first, and demand before speculation. Distance rather
			// than index so a backward seek is served as promptly as a forward one.
			queue.sort(
				(a, b) => a.priority - b.priority || Math.abs(a.segIdx - focus) - Math.abs(b.segIdx - focus)
			);
			const job = queue.shift()!;
			void execute(job, slot);
		}
	}

	async function execute(job: Job, slot: Slot): Promise<void> {
		try {
			const bytes = await encode(job, slot);
			cachePut(job.key, bytes);
			job.resolve(bytes);
		} catch (err) {
			job.reject(asError(err));
		} finally {
			pending.delete(job.key);
			slot.busy = false;
			slot.settle = null;
			pump();
		}
	}

	async function encode(job: Job, slot: Slot): Promise<Uint8Array> {
		const spec = job.track === 'video' ? videoSpec(job.repId) : audioSpec();
		const init = await sourceInit(job.track);
		const seg = await source.getSegment(job.track, job.segIdx);
		// The last AAC frame of an audio segment straddles rep 0's boundary; see
		// the grid argument in encode.worker.ts. Absent at EOF, which is fine.
		const next =
			job.track === 'audio'
				? await source.getSegment('audio', job.segIdx + 1).catch(() => undefined)
				: undefined;

		// close() can only settle a job the worker already holds. One still reading
		// its rep 0 bytes has no reply pending, so close() cannot reach it, and
		// posting it now would post to a terminated worker: the reply never comes
		// and whoever awaits this segment waits forever.
		if (closed) throw new Error('ladder is closed');

		const req: EncodeRequest = {
			t: 'encode',
			jobId: nextJobId++,
			track: job.track,
			init,
			seg,
			next,
			spec
		};
		// Deliberately no transfer list: these are source.ts's cached rep 0 bytes
		// and transferring them would detach the copy its own LRU still holds.
		const res = await post(slot, req);
		if (res.t === 'err') throw new Error(res.error);

		const ik = initKey(job.repId, job.track);
		if (!inits.has(ik)) inits.set(ik, res.init);
		return res.seg;
	}

	function sourceInit(track: Track): Promise<Uint8Array> {
		let p = sourceInits.get(track);
		if (!p) {
			p = source.getInit(track);
			sourceInits.set(track, p);
		}
		return p;
	}

	/* -------------------------------------------------------------- workers --- */

	function acquire(): Slot | null {
		let slot = slots.find((s) => !s.busy);
		if (!slot) {
			if (slots.length >= maxWorkers) return null;
			slot = { worker: newWorker(), busy: false, jobId: 0, settle: null };
			slots.push(slot);
		}
		slot.busy = true;
		return slot;
	}

	function newWorker(): Worker {
		// PLAN.md 4.5: on the main thread the encode janks the host's own playback,
		// which is unacceptable because the host is a participant and not a server.
		const worker = new Worker(new URL('./worker/encode.worker.ts', import.meta.url), {
			type: 'module'
		});
		worker.onmessage = (ev: MessageEvent<EncodeResponse>) => {
			const slot = slots.find((s) => s.worker === worker);
			// Slots outlive the jobs that run on them, so a reply is only this job's
			// if it names this job. Settling on an unmatched one would hand the bytes
			// of a segment nobody is waiting on to whoever is waiting now.
			if (!slot || ev.data?.jobId !== slot.jobId) return;
			const settle = slot.settle;
			slot.settle = null;
			settle?.(ev.data);
		};
		worker.onerror = (ev) => {
			// A worker that has raised an error event is not reusable, and a module
			// that failed to load never answers at all. Left in the pool it would take
			// the next job's postMessage into a void and that segment would be awaited
			// forever rather than failing. Drop it; pump() builds a fresh one.
			const idx = slots.findIndex((s) => s.worker === worker);
			if (idx < 0) return;
			const slot = slots[idx];
			slots.splice(idx, 1);
			worker.terminate();
			const settle = slot.settle;
			slot.settle = null;
			settle?.({ t: 'err', jobId: slot.jobId, error: ev.message || 'encode worker failed' });
		};
		return worker;
	}

	function post(slot: Slot, req: EncodeRequest): Promise<EncodeResponse> {
		return new Promise((resolve) => {
			slot.jobId = req.jobId;
			slot.settle = resolve;
			slot.worker.postMessage(req);
		});
	}

	/* ---------------------------------------------------------------- specs --- */

	function videoSpec(repId: number): VideoJobSpec {
		const encoder = configs.get(repId);
		if (!encoder || !videoDecoderConfig) {
			throw new Error(`rung ${repId} is not available on this device`);
		}
		return { kind: 'video', encoder, decoder: videoDecoderConfig };
	}

	function audioSpec(): AudioJobSpec {
		if (!audioEncoderConfig || !audioDecoderConfig) {
			throw new Error(audioUnavailableReason());
		}
		return { kind: 'audio', encoder: audioEncoderConfig, decoder: audioDecoderConfig };
	}

	function audioUnavailableReason(): string {
		if (!audio) return 'this file has no audio track';
		if (!audioDecoderConfig) {
			return `audio is ${audio.codec}, which this browser cannot decode`;
		}
		return `audio is ${audio.codec}, which browsers cannot play, and this device cannot encode AAC to replace it`;
	}

	/* ------------------------------------------------------------- serving --- */

	function isEncoded(repId: number, track: Track): boolean {
		if (track === 'audio') return audioTranscode;
		if (repId !== NATIVE_REP) return true;
		return videoTranscode;
	}

	async function getSegment(repId: number, track: Track, segIdx: number): Promise<Uint8Array> {
		if (track === 'audio') {
			if (!audio || probe.audioAction === 'none') throw new Error('this file has no audio track');
			if (!audioTranscode) return source.getSegment('audio', segIdx);
			await readyPromise;
			if (!audioEncoderConfig) throw new Error(audioUnavailableReason());
			return request(NATIVE_REP, 'audio', segIdx, PRIORITY_DEMAND);
		}

		if (!video || probe.videoAction === 'none') throw new Error('this file has no video track');
		if (repId === NATIVE_REP && !videoTranscode) {
			return source.getSegment('video', segIdx);
		}
		await readyPromise;
		if (!configs.has(repId)) {
			throw new Error(
				repId === NATIVE_REP
					? `video is ${video.codec}, which this browser can neither play nor re-encode`
					: `rung ${repId} is not available on this device`
			);
		}
		focus = segIdx;
		return request(repId, 'video', segIdx, PRIORITY_DEMAND);
	}

	async function getInit(rep: number, track: Track): Promise<Uint8Array> {
		const repId = repOf(rep, track);
		if (!isEncoded(repId, track)) return sourceInit(track);
		await readyPromise;
		const key = initKey(repId, track);
		const have = inits.get(key);
		if (have) return have;
		// The init is a by-product of an encode: it carries the encoder's own avcC
		// or AudioSpecificConfig, which is only knowable by encoding something.
		await request(repId, track, Math.max(0, focus), PRIORITY_DEMAND);
		const init = inits.get(key);
		if (!init) throw new Error(`could not produce an init segment for rep ${repId} ${track}`);
		return init;
	}

	function note(rep: number, track: Track, segIdx: number): void {
		if (closed) return;
		const repId = repOf(rep, track);
		if (track === 'video') focus = segIdx;
		if (!isEncoded(repId, track)) return;
		// A hint can arrive before the encoder configs are resolved, and a rung that
		// does not exist on this device must not queue jobs that only fail. A hint is
		// speculative all the way down, so a probe that could not resolve any config
		// is not this path's error to raise either -- unhandled, it would be an
		// uncaught rejection on a host that is otherwise playing fine.
		void readyPromise.then(
			() => {
				if (closed) return;
				if (track === 'video' && !configs.has(repId)) return;
				if (track === 'audio' && !audioEncoderConfig) return;
				for (let i = 0; i < LOOKAHEAD_SEGMENTS; i++) {
					const idx = segIdx + i;
					if (idx > maxSegIdx) break;
					// A guess that does not pan out is not an error, so its rejection is
					// not one either. The demand path reports for real.
					void request(repId, track, idx, PRIORITY_AHEAD).catch(() => {});
				}
			},
			() => {}
		);
	}

	function representation(repId: number, track: Track): RepresentationInfo | null {
		if (track === 'audio') {
			if (!audio || probe.audioAction === 'none') return null;
			if (!audioTranscode) {
				return {
					repId: NATIVE_REP,
					track: 'audio',
					codec: audio.codec,
					mimeType: 'audio/mp4',
					bandwidth: audio.bitrate,
					audioChannels: audio.channels,
					audioSampleRate: audio.sampleRate
				};
			}
			if (!audioEncoderConfig) return null;
			return {
				repId: NATIVE_REP,
				track: 'audio',
				codec: 'mp4a.40.2',
				mimeType: 'audio/mp4',
				bandwidth: audioEncoderConfig.bitrate ?? 128_000,
				audioChannels: audioEncoderConfig.numberOfChannels,
				audioSampleRate: audioEncoderConfig.sampleRate
			};
		}

		if (!video || probe.videoAction === 'none') return null;
		if (repId === NATIVE_REP && !videoTranscode) {
			return {
				repId: NATIVE_REP,
				track: 'video',
				codec: video.codec,
				mimeType: 'video/mp4',
				bandwidth: video.bitrate,
				width: video.width,
				height: video.height
			};
		}
		const cfg = configs.get(repId);
		if (!cfg) return null;
		return {
			repId,
			track: 'video',
			codec: cfg.codec,
			mimeType: 'video/mp4',
			bandwidth: cfg.bitrate ?? 0,
			width: cfg.width,
			height: cfg.height
		};
	}

	function close(): void {
		if (closed) return;
		closed = true;
		for (const slot of slots) {
			// Terminating a worker mid-job means its reply never arrives, so settle
			// the job first: otherwise whoever is awaiting that segment waits forever.
			const settle = slot.settle;
			slot.settle = null;
			settle?.({ t: 'err', jobId: slot.jobId, error: 'ladder is closed' });
			slot.worker.terminate();
		}
		slots.length = 0;
		for (const job of queue) job.reject(new Error('ladder is closed'));
		queue.length = 0;
		pending.clear();
		cache.clear();
		cacheBytes = 0;
		inits.clear();
		listeners.clear();
	}

	return {
		availableRungs: () => [...rungs],
		onRungsChanged: (cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		ready: () => readyPromise,
		representation,
		getInit,
		getSegment,
		note,
		close
	};
}

/* ----------------------------------------------------------------- config --- */

async function resolveVideoConfig(
	rung: Rung,
	video: VideoTrackInfo
): Promise<VideoEncoderConfig | null> {
	const size = fitSize(rung, video.width, video.height);
	if (!size) return null;
	const fps = video.fps > 0 ? Math.round(video.fps) : 30;
	const bitrate = rung.id === NATIVE_REP ? nativeBitrate(video) : rung.videoBitrate;
	const level = avcLevel(size.width, size.height, fps);

	// Software H.264 fallback (OpenH264) is Baseline only, so a High-profile
	// config would simply be unsupported on a machine without a hardware encoder
	// rather than quietly slower. Ask for the best each machine will actually take.
	for (const profile of ['64', '4d', '42']) {
		for (const hardwareAcceleration of ['prefer-hardware', undefined] as const) {
			const cfg: VideoEncoderConfig = {
				// PLAN.md 4.5: H.264 for every encoded rung. It is the only codec with
				// universally available hardware encode, and we are encoding in
				// realtime on a machine that is simultaneously a participant.
				codec: `avc1.${profile}00${level}`,
				width: size.width,
				height: size.height,
				bitrate,
				framerate: fps,
				// avcC, not annexb: MSE wants length-prefixed NALs, and the muxer needs
				// the decoder config the encoder only emits in this format.
				avc: { format: 'avc' },
				// The scaled rungs exist to be produced ahead of a moving playhead. Rep
				// 0 is what everyone falls back to and is worth the quality mode.
				latencyMode: rung.id === NATIVE_REP ? 'quality' : 'realtime',
				bitrateMode: 'variable',
				hardwareAcceleration
			};
			const support = await VideoEncoder.isConfigSupported(cfg).catch(() => null);
			if (support?.supported) return support.config ?? cfg;
		}
	}
	return null;
}

async function resolveAudioConfig(audio: AudioTrackInfo): Promise<AudioEncoderConfig | null> {
	// Windows' AAC encoder is stereo-only, so a 5.1 source has to fold down rather
	// than be refused (PLAN.md 4.3). The worker downmixes to whatever wins here.
	const candidates = [...new Set([audio.channels, 2, 1])].filter((c) => c >= 1);
	for (const numberOfChannels of candidates) {
		const cfg: AudioEncoderConfig = {
			codec: 'mp4a.40.2',
			sampleRate: audio.sampleRate,
			numberOfChannels,
			bitrate: aacBitrate(numberOfChannels)
		};
		const support = await AudioEncoder.isConfigSupported(cfg).catch(() => null);
		if (support?.supported) return support.config ?? cfg;
	}
	return null;
}

/** PLAN.md 4.4: audio is never re-encoded for bitrate, so this is a quality floor. */
function aacBitrate(channels: number): number {
	return Math.min(256_000, Math.max(96_000, 64_000 * channels));
}

/**
 * Fit inside the rung's box, never upscale. A rung at or above the source's own
 * resolution costs CPU to look worse than rep 0, so it is simply not offered;
 * a 480p file has no 720p rung and that is the correct ladder for that file.
 */
function fitSize(rung: Rung, srcW: number, srcH: number): { width: number; height: number } | null {
	if (srcW <= 0 || srcH <= 0) return null;
	if (rung.width === null || rung.height === null) return { width: even(srcW), height: even(srcH) };
	const scale = Math.min(rung.width / srcW, rung.height / srcH);
	if (scale >= 1) return null;
	return { width: even(srcW * scale), height: even(srcH * scale) };
}

function even(n: number): number {
	return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * Rep 0 under tier 2 is a re-encode of the whole picture, so it gets the source's
 * own bitrate or a resolution-derived floor, whichever is larger: a HEVC source
 * at 4 Mbps does not survive being re-encoded to H.264 at 4 Mbps.
 */
function nativeBitrate(video: VideoTrackInfo): number {
	const fps = video.fps > 0 ? video.fps : 30;
	const estimate = Math.round(video.width * video.height * fps * 0.1);
	const target = Math.max(video.bitrate > 0 ? video.bitrate : 0, estimate);
	return Math.min(16_000_000, Math.max(1_000_000, target));
}

/** H.264 Annex A limits. The level must fit the picture or the config is refused. */
const AVC_LEVELS: { hex: string; maxFS: number; maxMBPS: number }[] = [
	{ hex: '1e', maxFS: 1620, maxMBPS: 40_500 }, // 3.0
	{ hex: '1f', maxFS: 3600, maxMBPS: 108_000 }, // 3.1
	{ hex: '20', maxFS: 5120, maxMBPS: 216_000 }, // 3.2
	{ hex: '28', maxFS: 8192, maxMBPS: 245_760 }, // 4.0
	{ hex: '2a', maxFS: 8704, maxMBPS: 522_240 }, // 4.2
	{ hex: '32', maxFS: 22_080, maxMBPS: 589_824 }, // 5.0
	{ hex: '33', maxFS: 36_864, maxMBPS: 983_040 }, // 5.1
	{ hex: '34', maxFS: 36_864, maxMBPS: 2_073_600 } // 5.2
];

function avcLevel(width: number, height: number, fps: number): string {
	const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
	const level = AVC_LEVELS.find((l) => l.maxFS >= macroblocks && l.maxMBPS >= macroblocks * fps);
	return level?.hex ?? '34';
}

/**
 * PLAN.md 4.5 caps concurrent encodes at 1-2 to avoid hardware encoder
 * contention. The host is decoding and rendering the same movie on the same
 * chip; a third encode buys throughput we do not need and costs the host's own
 * playback, which is the one thing this must not do.
 */
function workerBudget(): number {
	const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 4) : 4;
	return cores >= 8 ? 2 : 1;
}

function initKey(repId: number, track: Track): string {
	return `${repId}/${track}`;
}

/**
 * PLAN.md 4.4: there is one audio representation and video rung selection never
 * affects it. A caller asking for rep 2's audio gets rep 0's, because that is
 * the only audio there is -- rather than a second encode of identical bytes
 * under a different key.
 */
function repOf(repId: number, track: Track): number {
	return track === 'audio' ? NATIVE_REP : repId;
}

function asError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}
