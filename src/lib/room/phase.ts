/**
 * Which wait a room page is in, or null when there is nothing to wait for.
 *
 * The page holds a dozen booleans that each say one thing went one way, and
 * the waiting room needs one word. The order here is the whole of the logic:
 * a dead end that was never attempted outranks a failure, a failure outranks a
 * wait, and a film on screen outranks a rejection of a different film. It is a
 * pure function of the page's signals so the order can be tested as a table
 * rather than by driving a browser into each corner.
 */

/**
 * - `searching`, `found`, `rejected`: a guest's waits, in the order they arrive.
 * - `hostless`: rendezvous found people, none of them the host, for long enough
 *   to say so. The search carries on.
 * - `failed`, `unreachable`: the ladder ended with nobody, or with someone it
 *   could not connect to. Opposite advice.
 * - `ended`: the host left.
 * - `invalid`, `nokey`, `insecure`: nothing was ever attempted, and why.
 * - `opening`, `unopened`: the host's own wait, and its failure.
 */
export type Phase =
	| 'searching'
	| 'found'
	| 'failed'
	| 'unreachable'
	| 'hostless'
	| 'ended'
	| 'invalid'
	| 'nokey'
	| 'insecure'
	| 'rejected'
	| 'opening'
	| 'unopened';

export type RoomSignals = {
	isHost: boolean;
	/** The URL's code could not name a room. */
	badCode: boolean;
	/** Not a secure context: the browser withholds the crypto rendezvous needs. */
	insecure: boolean;
	/** A guest's link carried no key. */
	noKey: boolean;
	/** The host's room is announced. */
	opened: boolean;
	/** A hard error has its own banner, which says more than a phase could. */
	error: boolean;
	/** How rendezvous ended, if it has. */
	rendezvous: 'pending' | 'failed' | 'unreachable';
	roomOver: boolean;
	/** A film is loaded on this page. */
	ready: boolean;
	/** The host's file was rejected and no film has superseded it. */
	rejected: boolean;
	/** The host has said hello. */
	hostFound: boolean;
	hostless: boolean;
};

export function roomPhase(s: RoomSignals): Phase | null {
	// The dead ends that were never attempted come first, whatever role the
	// reader had in mind: a broken link, a plain-http address, a link with no
	// key. Nothing can be retried from any of them, so the phase has to say so
	// ahead of anything a host check might otherwise show.
	if (s.badCode) return 'invalid';
	if (s.insecure) return 'insecure';
	if (s.noKey) return 'nokey';
	// A failed announce, ahead of the host check: it left the host the raw relay
	// log under a header naming the room it had just failed to open.
	if (s.isHost && s.rendezvous !== 'pending') return 'unopened';
	if (s.error) return null;
	// The host's remaining waits are the invite panel's and the picker's.
	if (s.isHost) return s.opened ? null : 'opening';
	if (s.rendezvous === 'unreachable') return 'unreachable';
	if (s.rendezvous === 'failed') return 'failed';
	// Outranks `ready`, since the host can also leave mid-film.
	if (s.roomOver) return 'ended';
	if (s.ready) return null;
	// Below `ready` on purpose: a rejection that outranked a playing film is a
	// bug this order makes unreachable rather than merely unlikely.
	if (s.rejected) return 'rejected';
	if (s.hostFound) return 'found';
	return s.hostless ? 'hostless' : 'searching';
}
