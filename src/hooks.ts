import type { Reroute } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { ROOM_PARAM } from '$lib/rendezvous/codes';

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
 * `/room/[id]` itself is untouched. It is still where the host lives and where
 * a code typed on the landing page goes, and links sent before this still open.
 */
export const reroute: Reroute = ({ url }) => {
	const code = url.searchParams.get(ROOM_PARAM);
	// An empty `?room=` names no room; let the landing page have it.
	if (!code || url.pathname !== resolve('/')) return;
	// Encoded so a mangled code cannot become extra path segments and miss the
	// room route, which is the page that knows how to say the link is broken.
	return resolve('/room/[id]', { id: encodeURIComponent(code) });
};
