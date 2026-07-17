/**
 * ICE configuration (PLAN.md 4.7, 9).
 *
 * STUN only, and deliberately so. TURN is the one thing in this design that
 * would require infrastructure and the only cost that scales with usage,
 * because it relays every byte. A host cannot run TURN -- the host's browser is
 * behind the very NAT that TURN exists to defeat -- so TURN is either
 * infrastructure or it is absent, and absent is where we start.
 *
 * The decision gets revisited with data, not vibes: `stats.svelte.ts` records
 * the selected candidate type on every connection. Every `relay` candidate
 * would have needed TURN; every `host`/`srflx` candidate did not.
 */

/** Public STUN. Free, static config, no server of ours involved. */
export const STUN_URLS = [
	'stun:stun.l.google.com:19302',
	'stun:stun1.l.google.com:19302',
	'stun:stun.cloudflare.com:3478'
];

export const RTC_CONFIG: RTCConfiguration = {
	iceServers: [{ urls: STUN_URLS }],
	// Small pool: rendezvous is one-shot per room and pre-gathering a large
	// pool costs STUN round trips we do not need.
	iceCandidatePoolSize: 1
};

export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

/**
 * Reads the candidate type of the pair actually in use. This is the
 * measurement that decides the TURN question in PLAN.md 9, so it is collected
 * from day one rather than added when someone wonders.
 */
export async function selectedCandidateType(pc: RTCPeerConnection): Promise<CandidateType> {
	let report: RTCStatsReport;
	try {
		report = await pc.getStats();
	} catch {
		return 'unknown';
	}

	let pairId: string | undefined;
	report.forEach((s) => {
		if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
			pairId = s.selectedCandidatePairId;
		}
	});

	let localId: string | undefined;
	if (pairId) {
		const pair = report.get(pairId) as { localCandidateId?: string } | undefined;
		localId = pair?.localCandidateId;
	} else {
		// Firefox does not always expose transport.selectedCandidatePairId.
		report.forEach((s) => {
			const p = s as RTCIceCandidatePairStats & { selected?: boolean };
			if (p.type === 'candidate-pair' && (p.selected || p.state === 'succeeded') && p.nominated) {
				localId = p.localCandidateId;
			}
		});
	}
	if (!localId) return 'unknown';

	const cand = report.get(localId) as { candidateType?: string } | undefined;
	const t = cand?.candidateType;
	return t === 'host' || t === 'srflx' || t === 'prflx' || t === 'relay' ? t : 'unknown';
}
