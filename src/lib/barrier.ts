/**
 * What the readiness barrier says while it holds the room.
 *
 * The banner has two readers with opposite stakes in it. To everyone else it
 * is news about someone: the film stopped, here is who for, nothing to do. To
 * the guest who is actually behind, it is the only explanation their screen
 * will ever offer for why the film froze - and "Waiting for Guest 412" is the
 * one sentence Guest 412 cannot recognise as being about themselves, because
 * the app never told them that is their name.
 *
 * So `you` is a fact off the wire, not a guess: the host says whether the
 * recipient is one of the guests it is waiting on (see `Waiting` in
 * protocol/control), and `others` never contains the recipient.
 *
 * `started` splits it again, because the barrier holds the room in two
 * completely different situations and only one of them is a fall-behind. Before
 * anyone has watched a frame, a guest with no buffer has not fallen behind
 * anything - they are loading the opening of a film that has not started, which
 * is what every guest does on the way in. That is the first thing a new guest
 * ever reads, so it may not open by blaming their connection for a stall that
 * has not happened.
 */
import { nameList } from '$lib/names';

export function waitingMessage(others: readonly string[], you: boolean, started: boolean): string {
	// "you" leads: the reader's own stake in the sentence should not be the
	// thing they find at the end of it.
	const names = you ? ['you', ...others] : others;
	if (names.length === 0) return '';
	// Deliberately not "Waiting for you to load the film": the parallel phrasing
	// keeps the accusation that the pre-roll case has to lose. Nobody is late,
	// the film is simply still arriving.
	if (!started) return `Still loading the film for ${nameList(names)}.`;
	return `Waiting for ${nameList(names)} to catch up.`;
}
