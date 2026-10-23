import { describe, expect, test } from 'bun:test';
import { buildMpd } from '$lib/media/manifest';
import { manifestRungs } from '$lib/media/shaka/rungs';
import type { RepresentationInfo, TrackIndex } from '$lib/media/types';

const index = (track: 'video' | 'audio', timescale: number): TrackIndex => ({
	track,
	timescale,
	durationSec: 8,
	presentationOffset: 0,
	presentationEnd: 8 * timescale,
	presentationDurationSec: null,
	segments: [
		{ index: 0, time: 0, duration: 4 * timescale },
		{ index: 1, time: 4 * timescale, duration: 4 * timescale }
	]
});

const videoRep = (repId: number, height: number, codec: string): RepresentationInfo => ({
	repId,
	track: 'video',
	codec,
	mimeType: 'video/mp4',
	bandwidth: 1000 * height,
	width: Math.round((height * 16) / 9),
	height
});

const audioRep: RepresentationInfo = {
	repId: 0,
	track: 'audio',
	codec: 'mp4a.40.2',
	mimeType: 'audio/mp4',
	bandwidth: 128_000,
	audioChannels: 2,
	audioSampleRate: 48_000
};

describe('buildMpd', () => {
	const mpd = buildMpd({
		durationSec: 8,
		video: {
			index: index('video', 90_000),
			reps: [videoRep(0, 1080, 'hvc1.2.4.L120.90'), videoRep(1, 720, 'avc1.640020')]
		},
		audio: { index: index('audio', 48_000), reps: [audioRep] }
	});

	test('REVIEW F-18: the audio set carries exactly the representations it was given', () => {
		const audioSet = /<AdaptationSet[^>]*contentType="audio"[\s\S]*?<\/AdaptationSet>/.exec(mpd)!;
		expect(audioSet[0].match(/<Representation /g)?.length).toBe(1);
	});

	test('the rung reader and the writer agree on the shape', () => {
		expect(manifestRungs(mpd, (t) => !/hvc1/.test(t))).toEqual([
			{ repId: 0, height: 1080, playable: false },
			{ repId: 1, height: 720, playable: true }
		]);
	});

	test('the presentation duration is measured off the emitted timeline', () => {
		expect(mpd).toContain('mediaPresentationDuration="PT8S"');
	});

	test('attribute values are escaped', () => {
		const odd = buildMpd({
			durationSec: 8,
			video: { index: index('video', 90_000), reps: [videoRep(0, 720, 'avc1"<&')] },
			audio: null
		});
		expect(odd).toContain('codecs="avc1&quot;&lt;&amp;"');
	});
});
