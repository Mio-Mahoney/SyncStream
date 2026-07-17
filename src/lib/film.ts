/**
 * What the room is watching.
 *
 * The room could account for every person in it - who is here, who you are
 * watching with, who it is waiting on - and never once said what was on. A guest
 * read "Room RHBGFD / 0:00 / 1:00 / Watching with Alice.", which names everybody
 * present and omits the only reason they came. The host had it worse in one
 * place: "Change video" opens a picker reading "Drop a video here" with nothing
 * on screen saying what it would replace, so the one control that gets you off a
 * wrong film never says which film it thinks is on.
 *
 * The name is the filename, verbatim. It is what the host picked it out of a
 * folder by and what they would recognise it as, and any tidying we invented
 * ("Arrival" from "Arrival.2016.1080p.mkv") would be a guess we cannot check -
 * one that reads as authoritative precisely when it is wrong.
 */

/**
 * Long enough for a filename people actually have, short enough that it cannot
 * wreck the row it lands in. A name is truncated on screen too (the whole thing
 * stays in a tooltip), but this bounds what goes on the wire: a guest renders
 * whatever the host sends, and a path-length filename is not something the
 * receiver should be discovering at layout time.
 */
export const TITLE_MAX = 120;

/**
 * The `…` is deliberate: a name we shortened must not read as the name of a file
 * someone has, or the host and their guests are talking about different films.
 */
export function filmTitle(fileName: string): string {
	const t = fileName.replace(/\s+/g, ' ').trim();
	return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}
