import { describe, expect, test } from 'bun:test';
import { roomPhase, type RoomSignals } from '$lib/room/phase';

const guest = (over: Partial<RoomSignals> = {}): RoomSignals => ({
	isHost: false,
	badCode: false,
	insecure: false,
	noKey: false,
	opened: false,
	error: false,
	rendezvous: 'pending',
	roomOver: false,
	ready: false,
	rejected: false,
	hostFound: false,
	hostless: false,
	...over
});
const host = (over: Partial<RoomSignals> = {}) => guest({ isHost: true, ...over });

describe('roomPhase', () => {
	test('a guest walks searching -> found -> (rejected) -> null as the room comes up', () => {
		expect(roomPhase(guest())).toBe('searching');
		expect(roomPhase(guest({ hostFound: true }))).toBe('found');
		expect(roomPhase(guest({ hostFound: true, rejected: true }))).toBe('rejected');
		expect(roomPhase(guest({ hostFound: true, rejected: true, ready: true }))).toBeNull();
	});

	test('a film on screen outranks a rejection of a different one', () => {
		expect(roomPhase(guest({ ready: true, rejected: true, hostFound: true }))).toBeNull();
	});

	test('the host leaving outranks the film', () => {
		expect(roomPhase(guest({ ready: true, roomOver: true, hostFound: true }))).toBe('ended');
	});

	test('the dead ends that were never attempted outrank everything, for either role', () => {
		for (const make of [guest, host]) {
			expect(roomPhase(make({ badCode: true, ready: true }))).toBe('invalid');
			expect(roomPhase(make({ insecure: true, ready: true }))).toBe('insecure');
		}
		expect(roomPhase(guest({ noKey: true }))).toBe('nokey');
	});

	test('rendezvous ending two ways gets opposite advice', () => {
		expect(roomPhase(guest({ rendezvous: 'failed' }))).toBe('failed');
		expect(roomPhase(guest({ rendezvous: 'unreachable' }))).toBe('unreachable');
	});

	test('people found but no host is its own wait, cleared by a hello', () => {
		expect(roomPhase(guest({ hostless: true }))).toBe('hostless');
		expect(roomPhase(guest({ hostless: true, hostFound: true }))).toBe('found');
	});

	test('a hard error has its own banner', () => {
		expect(roomPhase(guest({ error: true }))).toBeNull();
		expect(roomPhase(host({ error: true }))).toBeNull();
	});

	test('the host waits to open, then has no phase; a failed announce is unopened', () => {
		expect(roomPhase(host())).toBe('opening');
		expect(roomPhase(host({ opened: true }))).toBeNull();
		expect(roomPhase(host({ rendezvous: 'failed' }))).toBe('unopened');
		expect(roomPhase(host({ rendezvous: 'unreachable' }))).toBe('unopened');
	});
});
