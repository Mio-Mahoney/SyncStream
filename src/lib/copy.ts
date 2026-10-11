/**
 * What the product is, in the words every surface uses for it.
 *
 * Written down once because it is shown in three places that cannot see each
 * other: the landing page, the link-preview tags in the shell (filled in by
 * `hooks.server.ts`), and the card image (`scripts/og-image.js`). A messenger
 * puts the last two side by side, so a sentence edited in one and not the
 * other is visible to everyone the link is sent to.
 *
 * The image is committed, not built: after changing either string, run
 * `bun run og` to redraw it.
 */
export const TAGLINE = 'Play a video off your own disk and watch it together, in sync.';

/** The half of the pitch that is a promise. Set apart on the card, so kept apart here. */
export const PROMISE = 'Nothing uploads anywhere';

export const DESCRIPTION = `${TAGLINE} ${PROMISE}.`;
