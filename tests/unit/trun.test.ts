import { describe, expect, test } from 'bun:test';
import { fixTrunVersions } from '$lib/media/source';

/** Builds [moof [traf [trun]]] with the given per-sample composition offsets. */
function fragment(offsets: number[], version = 0, flags = 0x000a01): Uint8Array {
	// flags: data-offset (0x1), sample-duration (0x100), sample-size (0x200), cts (0x800)
	const perSample = 4 + 4 + 4;
	const trunLen = 8 + 4 + 4 + 4 + offsets.length * perSample;
	const trafLen = 8 + trunLen;
	const moofLen = 8 + trafLen;
	const buf = new Uint8Array(moofLen);
	const view = new DataView(buf.buffer);
	const box = (at: number, len: number, type: string) => {
		view.setUint32(at, len);
		for (let i = 0; i < 4; i++) buf[at + 4 + i] = type.charCodeAt(i);
	};
	box(0, moofLen, 'moof');
	box(8, trafLen, 'traf');
	box(16, trunLen, 'trun');
	view.setUint32(24, (version << 24) | flags);
	view.setUint32(28, offsets.length);
	view.setUint32(32, 0); // data offset
	let at = 36;
	for (const off of offsets) {
		view.setUint32(at, 512); // duration
		view.setUint32(at + 4, 100); // size
		view.setInt32(at + 8, off); // cts offset, two's complement as mp4box writes it
		at += 12;
	}
	return buf;
}

describe('fixTrunVersions (REVIEW F-09)', () => {
	test('a trun with a negative composition offset becomes version 1', () => {
		const out = fixTrunVersions(fragment([0, -512, 512]));
		expect(out[24]).toBe(1);
	});
	test('a trun with only non-negative offsets is left at version 0', () => {
		const out = fixTrunVersions(fragment([0, 512, 1024]));
		expect(out[24]).toBe(0);
	});
	test('a trun without composition offsets is untouched whatever its bytes say', () => {
		const out = fixTrunVersions(fragment([-1], 0, 0x000201));
		expect(out[24]).toBe(0);
	});
	test('an already-version-1 trun stays version 1', () => {
		const out = fixTrunVersions(fragment([-512], 1));
		expect(out[24]).toBe(1);
	});
	test('a malformed box size does not throw', () => {
		const bad = fragment([-512]);
		new DataView(bad.buffer).setUint32(16, 0xffffffff);
		expect(() => fixTrunVersions(bad)).not.toThrow();
	});
});
