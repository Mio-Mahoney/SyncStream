/**
 * Who you are in a watch party.
 *
 * Every name in this app was a machine's guess: guests were "Guest 412" and the
 * host was the literal string "Host". Every screen that reports on the room -
 * presence, the roster, the readiness barrier - was already built to render
 * names, and the wire has carried a `name` on `hello` since Phase 2, so the room
 * has always been able to say who is in it. It simply had nobody to say.
 *
 * That is not a cosmetic gap in a watch party. A host who sends the link to
 * three friends and reads "Guest 412 and Guest 500 are here" cannot tell which
 * two came, or who they are still waiting on. "Waiting for Guest 412 to catch
 * up" names the one person in the room whose connection the host might actually
 * ask about, and names them unrecognisably.
 *
 * A guest who has never named themselves is asked on the way in (NamePrompt),
 * but the asking is not a gate. "It opens the room straight away, with no code
 * to type" is the whole point of the invite, so the room connects and the film
 * loads behind the prompt under a fallback name, and the answer arrives as a
 * rename. Asked once, ever: a name or a skip is remembered.
 */

const KEY = 'syncstream:name';
/** Set once a guest has answered the prompt, either way, so it never nags. */
const ASKED_KEY = 'syncstream:name-asked';

/**
 * Long enough for a name, short enough that it cannot wreck the sentences it
 * lands in - "Waiting for X to catch up" is read at a glance while a film is
 * frozen, and the roster puts several of these in one line.
 */
export const NAME_MAX = 24;

/** Collapses whitespace and trims, so a name cannot be blank-but-truthy. */
export function normalizeName(raw: string): string {
	return raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/**
 * A name that arrived over the wire, which is to say a name nobody has checked:
 * `decodeControl` types a control message without validating it, the same gap
 * mesh's `handleHave` guards for segment keys. `normalizeName` above bounds a
 * name at the page that chose it - the one page with no reason to abuse it.
 *
 * The host is what states these names to the rest of the room, so an unbounded
 * one is not the sender's problem: it is everyone's presence line, roster and
 * barrier banner. `fallback` covers the name that is not a string at all, and
 * the one that normalises away to nothing, because every screen that renders a
 * name assumes it has one.
 */
export function remoteName(raw: unknown, fallback: string): string {
	if (typeof raw !== 'string') return fallback;
	return normalizeName(raw) || fallback;
}

/**
 * localStorage is not always there to read: it throws outright in some
 * privacy modes rather than returning null. A forgotten name is a fallback
 * name, which is exactly where this app has been all along, so there is nothing
 * here worth failing a room over.
 */
export function readName(): string {
	try {
		return normalizeName(localStorage.getItem(KEY) ?? '');
	} catch {
		return '';
	}
}

export function saveName(name: string): void {
	try {
		const n = normalizeName(name);
		if (n) localStorage.setItem(KEY, n);
		else localStorage.removeItem(KEY);
	} catch {
		// See readName. Their name still applies to this room; it just will not
		// survive to the next one.
	}
}

/**
 * Whether to put the name prompt in front of a guest: they have no name and
 * have never been asked. A storage that throws reads as "asked", because a
 * prompt that could never remember its answer would return on every visit.
 */
export function shouldAskName(): boolean {
	try {
		return !readName() && localStorage.getItem(ASKED_KEY) === null;
	} catch {
		return false;
	}
}

/** Records that the prompt was answered, by a name or by a skip. */
export function markNameAsked(): void {
	try {
		localStorage.setItem(ASKED_KEY, '1');
	} catch {
		// See shouldAskName: a storage that throws is never prompted from.
	}
}

/**
 * What the room calls you until you say otherwise - unchanged from what the app
 * has always generated, so a room where nobody names themselves reads exactly as
 * it did before.
 *
 * The guest's number is what keeps two unnamed guests apart; the host needs no
 * number because a room has exactly one.
 */
export function fallbackName(role: 'host' | 'guest'): string {
	return role === 'host' ? 'Host' : `Guest ${Math.floor(Math.random() * 900 + 100)}`;
}
