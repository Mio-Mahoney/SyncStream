import { describe, expect, test } from 'bun:test';
import { createMesh } from '$lib/mesh/mesh';
import { segKey } from '$lib/protocol/control';
import { fakeLink, fakeNetwork } from './fake-network';

/** A plausible fragment: a `moof` box header is what the honesty check looks for. */
function fragment(tag: number, size = 64): Uint8Array {
	const b = new Uint8Array(size);
	new DataView(b.buffer).setUint32(0, size);
	b.set([0x6d, 0x6f, 0x6f, 0x66], 4); // 'moof'
	b[8] = tag;
	return b;
}

const noAbort = new AbortController().signal;

describe('host tracker (REVIEW F-04)', () => {
	test('claims are scoped to the film on: setFilm forgets them, and a stale have is ignored', () => {
		const g1 = fakeLink('g1');
		const g2 = fakeLink('g2');
		const net = fakeNetwork([g1, g2]);
		const mesh = createMesh({
			network: net,
			hostPeerId: null,
			film: 'A',
			fetchFromHost: () => Promise.reject(new Error('host is the origin'))
		});
		const key = segKey(0, 'video', 3);
		mesh.handleHave('g1', 'A', [key]);
		expect(mesh.sources('A', [key])).toEqual({ [key]: ['g1'] });

		// The host switches films. Every claim named A's bytes.
		mesh.setFilm('B');
		expect(mesh.sources('B', [key])).toEqual({});
		// g1 has not rebuilt yet and re-announces A's cache; it must not refill.
		mesh.handleHave('g1', 'A', [key]);
		expect(mesh.sources('B', [key])).toEqual({});
		// A query stamped with the old film gets nothing either.
		mesh.handleHave('g2', 'B', [key]);
		expect(mesh.sources('A', [key])).toEqual({});
		expect(mesh.sources('B', [key])).toEqual({ [key]: ['g2'] });
		mesh.close();
	});

	test('a departed peer is no longer a source', () => {
		const g1 = fakeLink('g1');
		const net = fakeNetwork([g1]);
		const mesh = createMesh({
			network: net,
			hostPeerId: null,
			film: 'A',
			fetchFromHost: () => Promise.reject()
		});
		const key = segKey(0, 'video', 1);
		mesh.handleHave('g1', 'A', [key]);
		net.gone('g1');
		expect(mesh.sources('A', [key])).toEqual({});
		mesh.close();
	});
});

describe('guest mesh', () => {
	test('serve refuses a request for another film even when the key is cached (REVIEW F-04)', async () => {
		const host = fakeLink('host');
		const net = fakeNetwork([host]);
		const bytes = fragment(1);
		const mesh = createMesh({
			network: net,
			hostPeerId: 'host',
			film: 'A',
			fetchFromHost: async () => bytes
		});
		await mesh.fetch(0, 'video', 5, noAbort);
		expect(mesh.serve('other', 'A', 0, 'video', 5)).toBe(bytes);
		expect(mesh.serve('other', 'B', 0, 'video', 5)).toBeNull();
		mesh.close();
	});

	test('requests are stamped with the film and admitted before they are sent', async () => {
		const host = fakeLink('host');
		const peer = fakeLink('peer');
		const net = fakeNetwork([host, peer]);
		const fromHost = fragment(9);
		const mesh = createMesh({
			network: net,
			hostPeerId: 'host',
			film: 'A',
			fetchFromHost: async () => fromHost
		});
		const key = segKey(0, 'video', 2);

		// Ask the tracker, and have it point at `peer`.
		const first = mesh.fetch(0, 'video', 2, noAbort);
		const ask = host.sent.find((m) => m.t === 'sourcesReq');
		expect(ask).toMatchObject({ t: 'sourcesReq', film: 'A' });
		await first; // no answer yet: the first fetch went to the host
		host.receive({
			t: 'sourcesRes',
			reqId: (ask as { reqId: number }).reqId,
			sources: { [segKey(0, 'video', 3)]: ['peer'] }
		});

		// The next segment is claimed by the peer, so it is asked first.
		const second = mesh.fetch(0, 'video', 3, noAbort);
		const req = peer.sent.find((m) => m.t === 'segReq') as
			{ reqId: number; film: string; segIdx: number } | undefined;
		expect(req).toMatchObject({ film: 'A', segIdx: 3 });
		expect(peer.expected.has(req!.reqId), 'admitted before the request went out').toBe(true);
		const fromPeer = fragment(3);
		peer.deliver(req!.reqId, fromPeer);
		expect(await second).toBe(fromPeer);
		expect(mesh.stats.fromPeers).toBe(fromPeer.byteLength);
		expect(mesh.stats.fromHost).toBe(fromHost.byteLength);
		expect(mesh.serve('x', 'A', 0, 'video', 3)).toBe(fromPeer);
		expect(key).toBeDefined();
		mesh.close();
	});

	test('a peer answering with something that is not a fragment is penalised and the host answers', async () => {
		const host = fakeLink('host');
		const peer = fakeLink('peer');
		const net = fakeNetwork([host, peer]);
		const fromHost = fragment(7);
		const mesh = createMesh({
			network: net,
			hostPeerId: 'host',
			film: 'A',
			fetchFromHost: async () => fromHost
		});
		await mesh.fetch(0, 'video', 0, noAbort);
		const ask = host.sent.find((m) => m.t === 'sourcesReq') as { reqId: number };
		host.receive({
			t: 'sourcesRes',
			reqId: ask.reqId,
			sources: { [segKey(0, 'video', 1)]: ['peer'] }
		});

		const fetching = mesh.fetch(0, 'video', 1, noAbort);
		const req = peer.sent.find((m) => m.t === 'segReq') as { reqId: number };
		peer.deliver(req.reqId, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
		expect(await fetching).toBe(fromHost);
		expect(mesh.stats.fallbacks).toBe(1);
		mesh.close();
	});

	test('announces carry the film, and a have is a snapshot of the cache', async () => {
		const host = fakeLink('host');
		const net = fakeNetwork([host]);
		const mesh = createMesh({
			network: net,
			hostPeerId: 'host',
			film: 'A',
			fetchFromHost: async () => fragment(1)
		});
		await mesh.fetch(0, 'video', 0, noAbort);
		mesh.announce();
		await new Promise((r) => setTimeout(r, 1100));
		const have = host.sent.find((m) => m.t === 'have');
		expect(have).toEqual({ t: 'have', film: 'A', keys: [segKey(0, 'video', 0)] });
		mesh.close();
	});
});
