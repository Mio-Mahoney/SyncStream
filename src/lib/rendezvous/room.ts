/**
 * Room-level rendezvous policy (PLAN.md 4.6, 4.7).
 *
 * The transports below this file answer "is this strategy reachable". This
 * file answers "does this room exist, and where". Those are different
 * questions, and conflating them is what would make PLAN.md 4.6's guest
 * fall-through dead code -- see `joinRoomByCode`.
 */

import { generateRoomCode, isValidRoomCode } from '$lib/rendezvous/codes';
import {
	isStrategyName,
	type RendezvousSession,
	type StrategyName
} from '$lib/rendezvous/transport';
import { strategyLadder } from '$lib/rendezvous/trystero';

/**
 * Once one strategy confirms, the others get this long to finish before the
 * room code is shown without them. PLAN.md 4.6 wants the host announcing
 * everywhere, but a public MQTT broker that is merely slow must not hold the
 * room code hostage behind a full connect timeout. A strategy that misses this
 * window is dropped from the announce set, which costs only the guests whose
 * sole working strategy was that already-marginal relay.
 */
export const HOST_GRACE_MS = 2500;

/**
 * Per-strategy budget for a guest: relay confirmation AND first peer must both
 * land inside it, because a strategy that connects but shows no host is a
 * strategy the guest must fall through.
 */
export const GUEST_STRATEGY_BUDGET_MS = 10_000;

/**
 * The recommended window for an occupancy probe, exported so every caller of
 * `hostRoomChecked` uses the same number. Long enough for an incumbent host's
 * announce (trystero warms up at 233/533/1333ms before settling into its 5.3s
 * interval) to reach us and connect.
 */
export const OCCUPANCY_PROBE_MS = 1200;

/** The `?s=` query parameter from PLAN.md 4.6. */
export const STRATEGY_PARAM = 's';

export class RendezvousError extends Error {
	/** One entry per strategy tried, so a failure names what was attempted. */
	readonly attempts: readonly string[];

	constructor(message: string, attempts: readonly string[] = []) {
		super(attempts.length > 0 ? `${message} (${attempts.join('; ')})` : message);
		this.name = 'RendezvousError';
		this.attempts = attempts;
	}
}

export type HostRendezvous = {
	/** Every strategy that confirmed, in priority order. */
	sessions: RendezvousSession[];
	primary: StrategyName;
	code: string;
	leave(): Promise<void>;
};

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Leaves a session on a path where the caller has already failed.
 *
 * `RendezvousSession.leave()` can reject: it bottoms out in trystero's
 * `room.leave()`, which awaits an internal `leave` action send, and that send
 * rejects on a peer that disconnected underneath it. trystero's own
 * beforeunload handler wraps leave in `.catch(noOp)` for exactly this reason.
 *
 * Letting that rejection escape the ladder's catch block would replace the real
 * error with a cleanup error AND abandon the remaining strategies -- turning a
 * recoverable "try the next relay" into a hard rendezvous failure, which is the
 * one thing PLAN.md 4.6's ladder exists to prevent. A failure to clean up a
 * room we are already walking away from changes nothing the caller can act on.
 */
async function discard(session: RendezvousSession): Promise<void> {
	try {
		await session.leave();
	} catch {
		// Already failing; the cleanup outcome is not actionable.
	}
}

/** Forwards a caller's abort into a controller we also abort on our own terms. */
function link(controller: AbortController, signal: AbortSignal | undefined): () => void {
	if (!signal) return () => {};
	const onAbort = () => controller.abort(signal.reason);
	if (signal.aborted) onAbort();
	else signal.addEventListener('abort', onAbort, { once: true });
	return () => signal.removeEventListener('abort', onAbort);
}

/**
 * Announces a fresh room on every configured strategy at once (PLAN.md 4.6:
 * signaling is kilobytes and the host is one process, so this costs nothing).
 *
 * Resolves once at least one strategy confirms, so the code is never shown for
 * a room that does not exist. `primary` is the highest-priority strategy that
 * actually connected, which is what the share link carries.
 *
 * `opts.code` lets the caller supply the code instead of drawing a fresh one.
 * The room URL is minted before this runs, and a host that announced a
 * different code than the one on screen would be advertising a room nobody can
 * join. The caller owns the URL, so the caller owns the code; we still draw one
 * when it does not, and still regenerate on collision.
 */
export async function hostRoom(opts?: {
	signal?: AbortSignal;
	code?: string;
}): Promise<HostRendezvous> {
	const ladder = strategyLadder();
	if (ladder.length === 0) {
		throw new RendezvousError('rendezvous: no signaling strategy is configured');
	}

	const code = opts?.code ?? generateRoomCode();
	const stragglers = new AbortController();
	const unlink = link(stragglers, opts?.signal);

	let graceTimer: ReturnType<typeof setTimeout> | null = null;
	const startGrace = () => {
		graceTimer ??= setTimeout(
			() => stragglers.abort(new Error(`slower than ${HOST_GRACE_MS}ms after the first strategy`)),
			HOST_GRACE_MS
		);
	};

	let results: PromiseSettledResult<RendezvousSession>[];
	try {
		results = await Promise.allSettled(
			ladder.map((t) =>
				t.join(code, { signal: stragglers.signal }).then((session) => {
					startGrace();
					return session;
				})
			)
		);
	} finally {
		unlink();
		if (graceTimer !== null) clearTimeout(graceTimer);
	}

	// `ladder` is already in priority order, so `sessions` is too.
	const sessions: RendezvousSession[] = [];
	const attempts: string[] = [];
	results.forEach((r, i) => {
		if (r.status === 'fulfilled') sessions.push(r.value);
		else attempts.push(`${ladder[i]!.name}: ${errMessage(r.reason)}`);
	});

	// A caller-driven abort is not a rendezvous failure; report it as itself
	// rather than as "every strategy failed", but do not leak the sessions that
	// did connect before the abort landed.
	if (opts?.signal?.aborted) {
		await Promise.allSettled(sessions.map((s) => s.leave()));
		opts.signal.throwIfAborted();
	}

	if (sessions.length === 0) {
		throw new RendezvousError(
			`rendezvous: could not announce room ${code} on any strategy`,
			attempts
		);
	}

	const primary = sessions[0]!.strategy;

	return {
		sessions,
		primary,
		code,
		leave: async () => {
			await Promise.allSettled(sessions.map((s) => s.leave()));
		}
	};
}

/**
 * `hostRoom` plus the join-time occupancy check from PLAN.md 4.7.
 *
 * Codes are client-generated with no server to check collisions, so the only
 * detection available is observing the incumbent. That observation is a
 * control-channel question -- "did a peer announce itself as a HOST within
 * ~OCCUPANCY_PROBE_MS" -- and the control protocol is not owned here. This is
 * the seam: the caller (the room page) runs the hello/role handshake over the
 * channels it built on `r.sessions`, and answers the predicate. This function
 * owns only the retry policy.
 *
 * The predicate is called with a live rendezvous. If it returns true the room
 * is left and a fresh code is drawn; if it throws, the room is left and the
 * error propagates unchanged.
 */
export async function hostRoomChecked(
	isOccupied: (r: HostRendezvous) => Promise<boolean>,
	maxAttempts = 3,
	opts?: { signal?: AbortSignal; code?: string }
): Promise<HostRendezvous> {
	const tried: string[] = [];

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		opts?.signal?.throwIfAborted();
		// Only the first attempt honours the caller's code. A collision means
		// that exact code is taken, so retrying it would just collide again.
		const rendezvous = await hostRoom(attempt === 0 ? opts : { signal: opts?.signal });

		let occupied: boolean;
		try {
			occupied = await isOccupied(rendezvous);
		} catch (err) {
			await rendezvous.leave();
			throw err;
		}

		if (!occupied) return rendezvous;
		tried.push(rendezvous.code);
		await rendezvous.leave();
	}

	throw new RendezvousError(
		`rendezvous: ${maxAttempts} generated room codes were all already occupied`,
		tried
	);
}

/**
 * Resolves once `session` can see a peer, which for a guest is the only
 * evidence that the host is on this strategy.
 */
function awaitFirstPeer(
	session: RendezvousSession,
	ms: number,
	signal?: AbortSignal
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (f: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			f();
		};
		const onAbort = () => finish(() => reject(signal?.reason));
		const timer = setTimeout(
			() => finish(() => reject(new Error(`no host answered within ${ms}ms`))),
			ms
		);

		if (signal?.aborted) {
			finish(() => reject(signal.reason));
			return;
		}
		signal?.addEventListener('abort', onAbort, { once: true });
		// Replays peers already present, so a host that connected during relay
		// confirmation is not missed.
		session.onPeerJoin(() => finish(resolve));
	});
}

/**
 * Joins an existing room: the link's strategy first, then down the ladder
 * (PLAN.md 4.6). Rendezvous succeeds if any single backend works for both
 * parties.
 *
 * Success here means "a peer is visible on this strategy", NOT "the relay
 * connected". The distinction is the whole ladder: our relays are almost
 * always reachable, so a join that resolved on relay liveness alone would
 * always succeed on the first strategy and never fall through to the one the
 * host is actually on. Waiting for a peer is what makes the fall-through real,
 * and it is also the honest answer to "does this room exist" -- the room exists
 * exactly while its host is connected.
 */
export async function joinRoomByCode(
	code: string,
	preferred?: StrategyName,
	opts?: { signal?: AbortSignal }
): Promise<RendezvousSession> {
	if (!isValidRoomCode(code)) {
		throw new RendezvousError(`rendezvous: "${code}" is not a valid room code`);
	}

	const ladder = strategyLadder(preferred);
	if (ladder.length === 0) {
		throw new RendezvousError('rendezvous: no signaling strategy is configured');
	}

	const attempts: string[] = [];

	for (const transport of ladder) {
		opts?.signal?.throwIfAborted();

		// One deadline per strategy, split across two phases that fail for
		// different reasons: a relay that never connects and a relay with no
		// host on it are both "try the next one", but only distinct messages
		// tell you which happened.
		const deadline = Date.now() + GUEST_STRATEGY_BUDGET_MS;
		const budget = new AbortController();
		const unlink = link(budget, opts?.signal);
		const timer = setTimeout(
			() => budget.abort(new Error(`relay did not connect within ${GUEST_STRATEGY_BUDGET_MS}ms`)),
			GUEST_STRATEGY_BUDGET_MS
		);

		let session: RendezvousSession | null = null;
		try {
			session = await transport.join(code, { signal: budget.signal });
			clearTimeout(timer);
			// Whatever is left of the budget goes to finding the host.
			await awaitFirstPeer(session, Math.max(0, deadline - Date.now()), opts?.signal);
			return session;
		} catch (err) {
			if (session) await discard(session);
			// A caller-driven abort means stop, not "try the next relay".
			opts?.signal?.throwIfAborted();
			attempts.push(`${transport.name}: ${errMessage(err)}`);
		} finally {
			clearTimeout(timer);
			unlink();
		}
	}

	throw new RendezvousError(
		`rendezvous: room ${code} was not reachable on any strategy tried`,
		attempts
	);
}

/**
 * Builds the share link's query string (PLAN.md 4.6: `/room/ABC123?s=nostr`).
 * The host has connected before the link exists, so `primary` is always known
 * and correct.
 */
export function shareLinkQuery(primary: StrategyName): string {
	return `?${new URLSearchParams({ [STRATEGY_PARAM]: primary }).toString()}`;
}

/** The read side of `shareLinkQuery`, for the guest. */
export function strategyFromParams(params: URLSearchParams): StrategyName | undefined {
	const s = params.get(STRATEGY_PARAM);
	return isStrategyName(s) ? s : undefined;
}
