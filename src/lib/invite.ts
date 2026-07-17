/**
 * Names rather than a count. "1 watching" is a number a host has to trust;
 * "Guest 412 is here" is the same fact with the evidence attached, and it is
 * what tells them the link they just sent actually worked.
 *
 * Shared, because the host is asking the same question before the film ("did
 * my link work?") and during it ("who am I watching this with?"), and two
 * phrasings of one fact read as two different facts.
 */
export function presence(names: readonly string[]): string {
	if (names.length === 0) return 'No one has joined yet.';
	if (names.length === 1) return `${names[0]} is here.`;
	if (names.length === 2) return `${names[0]} and ${names[1]} are here.`;
	const others = names.length - 2;
	return `${names[0]}, ${names[1]} and ${others} ${others === 1 ? 'other' : 'others'} are here.`;
}
