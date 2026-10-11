import type { Reroute } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { parseRoomCode, roomParam } from '$lib/rendezvous/codes';

/**
 * Serves the room page at the invite link's address, `/?room=K7M4PQ`.
 *
 * The invite is a query on the root rather than `/room/K7M4PQ` because of what
 * a static host answers for each. The root is a real file and comes back 200.
 * A room path is no file at all: GitHub Pages can only hand back the 404.html
 * shell for it, and does so with a 404 status. A browser boots the app from
 * that body regardless, but the crawler building a preview card for a pasted
 * link stops at the status and shows nothing - and the invite is the one link
 * this product exists to have pasted.
 *
 * A reroute, not a redirect from the landing page. Redirecting would load the
 * landing page first and then the room, which is work in front of a guest's
 * first frame, and would move them onto the room path, where a reload is back
 * to a 404 response. Rerouted, the address never changes: the room page reads
 * the code as its `[id]` param exactly as it does on a room path, and both the
 * first load and every reload are the root file.
 *
 * `/room/[id]` itself is untouched, and nothing in the app navigates to it any
 * more: it is there for the links sent before this, which still open.
 */
export const reroute: Reroute = ({ url }) => {
	const raw = roomParam(url.searchParams);
	// An empty `?room=` names no room; let the landing page have it.
	if (!raw || !isRoot(url.pathname)) return;
	// Never the raw value. A URL collapses `.` and `..` wherever they appear in
	// a path, so those two would walk out of the room route - to no page and to
	// the landing page - and no escaping survives that. Anything that is not a
	// code goes in as one fixed stand-in, which the room page reads as it would
	// any other broken code: it is the page that knows how to say so.
	return resolve('/room/[id]', { id: parseRoomCode(raw) ?? NOT_A_CODE });
};

/** A room id that can never be a code, standing in for every value that is not one. */
const NOT_A_CODE = '-';

/**
 * Every spelling of the root an invite can arrive on. They are one file to the
 * host, but the link passes through messengers that trim a trailing slash and
 * hosts that serve the shell at `index.html` without redirecting, and an exact
 * match dropped the code on those: the guest got the start page, or a 404, and
 * no hint that the link had named a room.
 */
function isRoot(pathname: string): boolean {
	const root = resolve('/');
	return pathname === root || `${pathname}/` === root || pathname === `${root}index.html`;
}
