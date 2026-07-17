/**
 * The rendezvous seam (PLAN.md 4.6).
 *
 * This interface exists so the free-tier decision stays reversible. Everything
 * above it consumes a `RendezvousSession` and knows nothing about trystero,
 * Nostr, or Supabase. If free-tier rendezvous ever becomes untenable, a
 * Cloudflare Worker with one Durable Object per room implements this interface
 * and nothing else in the codebase moves.
 *
 * The debt is never the implementation, it is the coupling.
 */

export type StrategyName = 'supabase' | 'nostr' | 'mqtt';

/**
 * Priority order from PLAN.md 4.6. Supabase leads when configured because it
 * is operated and predictable; the public-relay strategies need no account and
 * have no quota, so they are the zero-cost floor that is always available.
 */
export const STRATEGY_ORDER: readonly StrategyName[] = ['supabase', 'nostr', 'mqtt'];

export function isStrategyName(x: unknown): x is StrategyName {
	return typeof x === 'string' && (STRATEGY_ORDER as readonly string[]).includes(x);
}

export type RendezvousSession = {
	readonly strategy: StrategyName;
	readonly selfId: string;

	/**
	 * The raw RTCPeerConnection for a peer.
	 *
	 * This is the whole reason we use trystero for rendezvous only (PLAN.md
	 * 4.6). We create our own data channels on this connection with our own
	 * framing and backpressure. Media never goes through a wrapper's
	 * data-channel API.
	 */
	getPeerConnection(peerId: string): RTCPeerConnection | undefined;

	peers(): string[];
	onPeerJoin(cb: (peerId: string) => void): void;
	onPeerLeave(cb: (peerId: string) => void): void;
	leave(): Promise<void>;
};

export type JoinOptions = {
	/** Aborts a join that is taking too long, so the ladder can fall through. */
	signal?: AbortSignal;
};

export type SignalingTransport = {
	readonly name: StrategyName;
	/**
	 * False when the strategy needs credentials that are not present. An
	 * unconfigured strategy is skipped by the ladder rather than attempted and
	 * failed, so it costs no connect timeout.
	 */
	isConfigured(): boolean;
	join(roomId: string, opts?: JoinOptions): Promise<RendezvousSession>;
};
