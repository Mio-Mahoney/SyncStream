import { describe, expect, test } from 'bun:test';
import { manifestRungs, rungWindow } from '$lib/media/shaka/rungs';

const reps = (playable: boolean[]) =>
	[1080, 720, 480, 360].map((height, i) => ({ repId: i, height, playable: playable[i] }));

describe('rungWindow (REVIEW F-10)', () => {
	test('no warmth known: no window', () => {
		expect(rungWindow(reps([true, true, true, true]), [])).toBeNull();
	});
	test('everything warm and playable: unrestricted', () => {
		expect(rungWindow(reps([true, true, true, true]), [0, 1, 2, 3])).toEqual({
			minHeight: 0,
			maxHeight: Infinity
		});
	});
	test('a warm prefix is stated exactly', () => {
		expect(rungWindow(reps([true, true, true, true]), [0, 1])).toEqual({
			minHeight: 720,
			maxHeight: 1080
		});
	});
	test('native unplayable and only native warm: the smallest playable rung, alone', () => {
		expect(rungWindow(reps([false, true, true, true]), [0])).toEqual({
			minHeight: 360,
			maxHeight: 360
		});
	});
	test('native unplayable, 720p warm: the warm playable set', () => {
		expect(rungWindow(reps([false, true, true, true]), [0, 1])).toEqual({
			minHeight: 720,
			maxHeight: 720
		});
	});
	test('nothing playable: null, so the load fails on its own terms', () => {
		expect(rungWindow(reps([false, false, false, false]), [0, 1, 2, 3])).toBeNull();
	});
});

describe('manifestRungs', () => {
	const mpd = `<?xml version="1.0"?><MPD><Period>
  <AdaptationSet contentType="video" mimeType="video/mp4">
    <Representation id="0" codecs="hvc1.2.4.L120.90" bandwidth="8000000" width="1920" height="1080"/>
    <Representation id="1" codecs="avc1.640020" bandwidth="2500000" width="1280" height="720"/>
    <Representation id="3" codecs="avc1.64001e" bandwidth="400000" width="640" height="360"/>
  </AdaptationSet>
  <AdaptationSet contentType="audio" mimeType="audio/mp4">
    <Representation id="0" codecs="mp4a.40.2" bandwidth="128000"></Representation>
  </AdaptationSet>
</Period></MPD>`;

	test('reads the video reps with the browser’s own answer per codec', () => {
		const got = manifestRungs(mpd, (type) => !/hvc1|hev1/.test(type));
		expect(got).toEqual([
			{ repId: 0, height: 1080, playable: false },
			{ repId: 1, height: 720, playable: true },
			{ repId: 3, height: 360, playable: true }
		]);
	});
	test('a throwing isTypeSupported reads as unplayable, never as a crash', () => {
		const got = manifestRungs(mpd, () => {
			throw new Error('no MSE');
		});
		expect(got.every((r) => !r.playable)).toBe(true);
	});
	test('no video set: nothing', () => {
		expect(manifestRungs('<MPD/>', () => true)).toEqual([]);
	});
});
