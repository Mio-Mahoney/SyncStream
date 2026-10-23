import { describe, expect, test } from 'bun:test';
import {
	FaultError,
	decodeControl,
	encodeControl,
	faultOf,
	isFault,
	parseSegKey,
	segKey
} from '$lib/protocol/control';

describe('segment keys', () => {
	test('round-trip, including the init sentinel', () => {
		expect(parseSegKey(segKey(2, 'audio', -1))).toEqual({ repId: 2, track: 'audio', segIdx: -1 });
	});
	test('reject anything that is not rep/track/index', () => {
		expect(parseSegKey('1/video')).toBeNull();
		expect(parseSegKey('x/video/1')).toBeNull();
		expect(parseSegKey('1/text/1')).toBeNull();
		expect(parseSegKey('1/video/1.5')).toBeNull();
	});
});

describe('control framing', () => {
	test('decodes what it encodes and refuses garbage', () => {
		const msg = { t: 'ping' as const, t0: 1 };
		expect(decodeControl(encodeControl(msg))).toEqual(msg);
		expect(decodeControl('not json')).toBeNull();
		expect(decodeControl('42')).toBeNull();
		expect(decodeControl('{"nope":1}')).toBeNull();
	});
});

describe('faults', () => {
	test('isFault checks the shape a peer sent, not the type it was declared with', () => {
		expect(isFault({ code: 'codec', detail: 'x' })).toBe(true);
		expect(isFault({ code: 'codec', detail: 'x', remedy: 'y' })).toBe(true);
		expect(isFault({ code: 'codec' })).toBe(false);
		expect(isFault({ code: 1, detail: 'x' })).toBe(false);
		expect(isFault(null)).toBe(false);
	});
	test('faultOf keeps a FaultError whole and codes anything else', () => {
		const f = { code: 'container' as const, detail: 'd', remedy: 'r' };
		expect(faultOf(new FaultError(f))).toEqual(f);
		expect(faultOf(new Error('boom'), 'encoder')).toEqual({ code: 'encoder', detail: 'boom' });
		expect(faultOf('str')).toEqual({ code: 'unknown', detail: 'str' });
	});
});
