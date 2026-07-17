/**
 * Names rather than a count. "1 watching" is a number a host has to trust;
 * "Guest 412 is here" is the same fact with the evidence attached, and it is
 * what tells them the link they just sent actually worked.
 *
 * Shared, because the host is asking the same question before the film ("did
 * my link work?") and during it ("who am I watching this with?"), and two
 * phrasings of one fact read as two different facts.
 */
import { nameList } from '$lib/names';

export function presence(names: readonly string[]): string {
	if (names.length === 0) return 'No one has joined yet.';
	return `${nameList(names)} ${names.length === 1 ? 'is' : 'are'} here.`;
}
