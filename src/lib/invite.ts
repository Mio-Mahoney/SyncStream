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

/**
 * The same roster read from the other end of the room.
 *
 * Deliberately not `presence()`. The host is asking whether anyone came, so an
 * empty room is news they need ("No one has joined yet"). A guest is asking who
 * they are watching with, and the answer always includes the host - a guest with
 * nobody left has no room, which is a screen of its own, not a line under a
 * player. And "Host and Guest 412 are here" is the host's sentence: it reports
 * on the room from outside it, when the reader is in it.
 */
export function watching(names: readonly string[]): string {
	if (names.length === 0) return '';
	return `Watching with ${nameList(names)}.`;
}
