/**
 * Renders `static/og.png`, the card a messenger shows when a SyncStream link is
 * pasted into it (see the og: tags in src/app.html).
 *
 * The image is committed, and this is its source: it is drawn in HTML with the
 * app's own palette, typeface and words so it can be regenerated when any of
 * them changes, rather than being a binary nobody can edit. All three are read
 * from where the app keeps them (tailwind.config.js, src/app.css,
 * src/lib/copy.ts), not restated here. Run with `bun run og`; it is not part of
 * the build, which must not need a browser.
 *
 * 1200x630 is the size every large-card preview is cropped from. The content
 * keeps clear of the edges because some clients crop toward a square.
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwind from '../tailwind.config.js';
import { PROMISE, TAGLINE } from '../src/lib/copy.ts';

const WIDTH = 1200;
const HEIGHT = 630;

const { moonstone, vanilla, tangerine } = tailwind.theme.extend.colors;
const out = fileURLToPath(new URL('../static/og.png', import.meta.url));

// The stylesheet the app itself loads its typeface from.
const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
const fonts = /@import url\('(https:\/\/fonts\.googleapis\.com\/[^']+)'\)/.exec(css)?.[1];
if (!fonts) throw new Error('og-image: found no Google Fonts @import in src/app.css');

const html = `<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
		<link rel="stylesheet" href="${fonts.replaceAll('&', '&amp;')}" />
		<style>
			* { box-sizing: border-box; margin: 0; }
			body {
				width: ${WIDTH}px;
				height: ${HEIGHT}px;
				display: flex;
				align-items: center;
				justify-content: center;
				background: ${vanilla[100]};
				font-family: Roboto, sans-serif;
			}
			.card {
				width: 920px;
				padding: 72px 64px 68px;
				text-align: center;
				background: rgb(255 255 255 / 0.7);
				border: 2px solid ${moonstone[200]};
				border-radius: 28px;
			}
			h1 { font-size: 116px; font-weight: 400; line-height: 1; color: #000; }
			p {
				margin: 32px auto 0;
				max-width: 720px;
				font-size: 38px;
				line-height: 1.35;
				color: ${moonstone[800]};
			}
			.pill {
				display: inline-block;
				margin-top: 44px;
				padding: 16px 44px;
				font-size: 34px;
				color: #000;
				background: ${tangerine[400]};
				border: 2px solid ${tangerine[600]};
				border-radius: 8px;
			}
		</style>
	</head>
	<body>
		<div class="card">
			<h1>SyncStream</h1>
			<p>${TAGLINE}</p>
			<span class="pill">${PROMISE}</span>
		</div>
	</body>
</html>`;

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
	await page.setContent(html, { waitUntil: 'networkidle' });
	// Drawn in a fallback face, the card would be committed looking unlike the app.
	await page.evaluate(() => document.fonts.ready);
	// Asked of the faces themselves. `document.fonts.check()` cannot be asked:
	// it answers true when no face of that name is registered at all, which is
	// exactly what a stylesheet that failed to arrive leaves behind.
	const loaded = await page.evaluate(() =>
		[...document.fonts].some(
			(face) => face.family.replace(/["']/g, '') === 'Roboto' && face.status === 'loaded'
		)
	);
	if (!loaded)
		throw new Error('og-image: Roboto did not load, refusing to write a fallback-font card');
	await page.screenshot({ path: out });
	console.log(`og-image: wrote ${out}`);
} finally {
	await browser.close();
}
