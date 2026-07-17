/**
 * Joining a list of people into a phrase, in the one shape this app uses.
 *
 * Shared because the room asks two questions about the same list of guests -
 * who is here, and who is holding the film up - and a list that reads "Guest
 * 412 and Guest 500" in one sentence and "Guest 412, Guest 500" in the next
 * reads as two different sets of people.
 *
 * Truncated past two names on purpose: the exact roster stops being the point
 * once it is long enough to scan, and the sentence has to stay a sentence.
 */
export function nameList(names: readonly string[]): string {
	if (names.length === 0) return '';
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	const others = names.length - 2;
	return `${names[0]}, ${names[1]} and ${others} ${others === 1 ? 'other' : 'others'}`;
}
