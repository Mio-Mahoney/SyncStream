import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import { env } from '$env/dynamic/public';
import { DESCRIPTION } from '$lib/copy';

/**
 * Fills in the parts of the shell's link-preview tags (src/app.html) that are
 * not its own to state: the product's description, which is written down once
 * in `$lib/copy`, and the origin the build is being deployed to.
 *
 * This is not a server (PLAN.md 4.7). Nothing prerenders, so the only thing
 * that ever passes through here in a build is the one shell every route boots
 * from, as it is written to disk; `static.spec.ts` holds the build to having no
 * server entry point at all.
 */
export const handle: Handle = ({ event, resolve }) =>
	resolve(event, {
		transformPageChunk: ({ html }) =>
			html.replaceAll('%app.description%', attr(DESCRIPTION)).replaceAll('%app.origin%', origin)
	});

/**
 * Where the build will be served from, with no trailing slash, or '' when it
 * was not told. The slash is trimmed because the tag appends a path to this,
 * and an origin copied out of a browser's address bar ends in one.
 */
const origin = attr((env.PUBLIC_ORIGIN ?? '').trim().replace(/\/+$/, ''));

// Said at build time because nothing fails otherwise: the site works, and the
// only symptom is an invite with no image on its card, in someone else's chat.
if (building && !origin) {
	console.warn(
		'\nlink previews: PUBLIC_ORIGIN is not set, so og:image is a relative URL and preview ' +
			'crawlers will ignore it.\nBuild with PUBLIC_ORIGIN=https://your.host for a deploy ' +
			'(README.md, "Link previews").\n'
	);
}

function attr(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
