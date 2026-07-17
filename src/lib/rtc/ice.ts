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

/**
 * Vite only inlines `import.meta.env` keys matching its `envPrefix`, which
 * vite.config.ts widens to include `PUBLIC_`. Absent these vars TURN is simply
 * not configured, which is the intended default and what PLAN.md 9 ships.
 *
 * Read as a raw record rather than through `$env/static/public`, which fails
 * the BUILD when a var is unset: "unset" has to be a runtime answer here rather
 * than a broken deploy.
 */
const env = import.meta.env as unknown as Record<string, string | undefined>;

/**
 * A TURN server, if one is configured. Credentials in a static build are public
 * by construction -- anyone can read them out of the bundle -- so whatever is
 * pointed at here must be something you are willing to expose. That means a
 * quota'd or ephemeral-credential service, never a flat-rate relay you would
 * mind strangers using. PLAN.md 9 covers the policy (coturn's own
 * `max-bps`/`user-quota`/`total-quota`, and `denied-peer-ip` for RFC1918, since
 * an open relay reaching internal addresses is an SSRF pivot).
 */
function turnServer(): RTCIceServer | null {
	const urls = env.PUBLIC_TURN_URLS;
	if (!urls) return null;
	const username = env.PUBLIC_TURN_USERNAME;
	const credential = env.PUBLIC_TURN_CREDENTIAL;
	// A TURN URL without credentials is not a degraded TURN server, it is an ICE
	// server the browser will try and fail on, wasting gathering time on every
	// connection. Treat a half-configured TURN as no TURN.
	if (!username || !credential) return null;
	return { urls: urls.split(',').map((u) => u.trim()), username, credential };
}

/**
 * TURN is absent unless configured, per PLAN.md 9: it is the only cost that
 * scales with usage, because it relays every byte. STUN alone handles ordinary
 * residential NAT, which is most of them; symmetric NAT and CGNAT are what fail,
 * and `stats.svelte.ts` records the candidate type on every connection so that
 * rate is measured rather than guessed.
 *
 * When the measurement says TURN is needed, this turns on with env vars and no
 * code change. `iceTransportPolicy` stays 'all' regardless -- TURN is the
 * fallback for peers that cannot connect directly, never the default path, or
 * every room would relay its video through someone else's bandwidth bill.
 */
export function buildRtcConfig(): RTCConfiguration {
	const turn = turnServer();
	return {
		iceServers: turn ? [{ urls: STUN_URLS }, turn] : [{ urls: STUN_URLS }],
		// Small pool: rendezvous is one-shot per room and pre-gathering a large
		// pool costs STUN round trips we do not need.
		iceCandidatePoolSize: 1
	};
}

export const RTC_CONFIG: RTCConfiguration = buildRtcConfig();

/** Whether a TURN server is configured, for the debug overlay and diagnostics. */
export const HAS_TURN = turnServer() !== null;

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
