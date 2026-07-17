<script lang="ts">
	/**
	 * The player's control bar. Playback intent is not ours to decide: play,
	 * pause and seek are routed out through callbacks so the host stays the one
	 * authority (PLAN.md 4.9). Volume, mute and fullscreen never leave this
	 * component, because they are the viewer's own business and syncing them
	 * across the room would be a misfeature.
	 */
	interface Props {
		video: HTMLVideoElement;
		/** Fullscreened instead of the bare <video>, so these controls survive it. */
		container: HTMLElement | undefined;
		playing: boolean;
		currentTime: number;
		duration: number;
		onToggle: () => void;
		onSeek: (seconds: number) => void;
	}

	let { video, container, playing, currentTime, duration, onToggle, onSeek }: Props = $props();

	const SKIP = 5;

	let volume = $state(1);
	let muted = $state(false);

	/**
	 * Fullscreen, and ours - not merely "something on this document is
	 * fullscreen". Everything below dresses the bar differently depending on it,
	 * so a fullscreen element that is not our player must not count.
	 */
	let fullscreenEl = $state<Element | null>(null);
	const fullscreen = $derived(!!container && !!fullscreenEl && container.contains(fullscreenEl));

	/** No pointer, key or focus for IDLE_MS. Only ever set while fullscreen. */
	let idle = $state(false);
	/** The pointer is resting on the bar. A still pointer is still a pointer. */
	let hovering = $state(false);
	/**
	 * Someone tabbed into the bar. Controls must not vanish out from under a
	 * keyboard, which has no pointer to wake them with and would be left tabbing
	 * blind through an invisible row.
	 *
	 * `:focus-visible` and not focus: clicking the fullscreen button is how you
	 * get here in the first place, and it leaves that button focused for the rest
	 * of the film - so a plain focus check is permanently true and the bar never
	 * hides at all. That is the distinction the pseudo-class exists to draw.
	 */
	let focusWithin = $state(false);
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const IDLE_MS = 2500;

	/**
	 * The bar is chrome in the window and an intrusion in fullscreen.
	 *
	 * Watching fullscreen meant a 52px opaque cream slab burned across the bottom
	 * of the picture for the whole film, and 668px of a 720px screen given to the
	 * film - permanently, because nothing ever took it away. So it hides itself
	 * once the room has been left alone, the way every player does.
	 *
	 * Only while playing: a paused film with no controls is a dead end, since
	 * nothing else on a fullscreen screen says how to start it again.
	 */
	const chromeHidden = $derived(fullscreen && playing && idle && !hovering && !focusWithin);

	function wake() {
		idle = false;
		clearTimeout(idleTimer);
		if (!fullscreen || !playing) return;
		idleTimer = setTimeout(() => (idle = true), IDLE_MS);
	}

	/**
	 * Restarts the countdown whenever the conditions for hiding change, so
	 * entering fullscreen or resuming a paused film gets a full IDLE_MS with the
	 * controls up rather than inheriting a timer from before.
	 */
	$effect(() => {
		void fullscreen;
		void playing;
		wake();
		return () => clearTimeout(idleTimer);
	});

	/**
	 * The cursor is the other half of the intrusion, and it sits over the film
	 * rather than over this bar, so it can only be hidden from the element that
	 * spans the picture. That is the same element this component already asks to
	 * go fullscreen.
	 */
	$effect(() => {
		if (!container) return;
		container.classList.toggle('cursor-none', chromeHidden);
		return () => container.classList.remove('cursor-none');
	});

	/**
	 * Where the thumb sits while dragging. A seek is only worth broadcasting once
	 * the drag settles, so during it we show the scrub target locally rather than
	 * currentTime, which is still back where playback actually is.
	 */
	let scrubbing = $state<number | null>(null);
	const shownTime = $derived(scrubbing ?? currentTime);
	const progress = $derived(duration > 0 ? (shownTime / duration) * 100 : 0);

	/** Hours only earn a slot once the media is long enough to have them. */
	function fmt(seconds: number, pad: boolean): string {
		if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
		const total = Math.floor(seconds);
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const s = total % 60;
		const mm = pad || h > 0 ? String(m).padStart(2, '0') : String(m);
		return h > 0
			? `${h}:${mm}:${String(s).padStart(2, '0')}`
			: `${mm}:${String(s).padStart(2, '0')}`;
	}

	const long = $derived(duration >= 3600);
	const elapsed = $derived(fmt(shownTime, long));
	const total = $derived(fmt(duration, long));

	function commitSeek(e: Event) {
		const t = Number((e.target as HTMLInputElement).value);
		scrubbing = null;
		onSeek(t);
	}

	function skip(by: number) {
		onSeek(Math.min(Math.max(currentTime + by, 0), duration || Infinity));
	}

	function applyVolume() {
		video.volume = volume;
		video.muted = muted || volume === 0;
	}

	/**
	 * A muted slider reads 0 rather than sitting at the old level, so dragging it
	 * anywhere is an unambiguous ask to hear something again. Dragging to zero is
	 * just a mute by another name.
	 */
	function onVolumeInput(e: Event) {
		volume = Number((e.target as HTMLInputElement).value);
		muted = volume === 0;
		applyVolume();
	}

	function toggleMute() {
		muted = !muted;
		// Unmuting back to a level of zero would look broken - nothing happens.
		if (!muted && volume === 0) volume = 1;
		applyVolume();
	}

	async function toggleFullscreen() {
		const target = container ?? video;
		if (document.fullscreenElement) await document.exitFullscreen();
		else await target.requestFullscreen();
	}

	/**
	 * Shortcuts are a window listener rather than a handler on the bar, since the
	 * thing a viewer is looking at (and clicking) is the video, not the button.
	 * Typing a room code somewhere else must never scrub the film.
	 */
	function onKey(e: KeyboardEvent) {
		// Before the guards: a keystroke is activity whether or not it is one of
		// ours, and a shortcut that acted on a bar nobody can see would be worse
		// than the bar.
		wake();
		const el = e.target as HTMLElement | null;
		if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
		if (e.metaKey || e.ctrlKey || e.altKey) return;

		switch (e.key) {
			case ' ':
			case 'k':
				e.preventDefault();
				onToggle();
				break;
			case 'ArrowLeft':
				e.preventDefault();
				skip(-SKIP);
				break;
			case 'ArrowRight':
				e.preventDefault();
				skip(SKIP);
				break;
			case 'm':
				toggleMute();
				break;
			case 'f':
				void toggleFullscreen();
				break;
		}
	}
</script>

<!--
	`wake` on the window rather than on the player: in fullscreen the player IS
	the window, and outside it there is nothing to wake, so the extra reach costs
	nothing and a pointer crossing from the page onto the film is one gesture.
-->
<svelte:window
	onkeydown={onKey}
	onpointermove={wake}
	onpointerdown={wake}
	onfullscreenchange={() => (fullscreenEl = document.fullscreenElement)}
/>

<!--
	One row where there is room for one, two where there is not. The bar's fixed
	parts (play, both timestamps, mute, volume, fullscreen) need ~454px before the
	seek gets a pixel, so on a phone they used to run straight off the end of a
	player that is `overflow-hidden` - not scrolled off, gone. Fullscreen went
	first, which on a phone is the one control worth having.

	`order` rather than two blocks of markup: the seek sits *between* the fixed
	parts when it is inline, and above all of them when it is not, so there is no
	way to slice the row into groups that read correctly at both sizes.
-->

<!--
	`shrink-0` because the player is a flex column that the window can squeeze: the
	film gives up height when there is not enough, and the bar never does. A bar
	that shrank would take the fold's place - clipping its own controls out of an
	`overflow-hidden` player, which is the defect the wrapping above prevents.

	Out of flow in fullscreen, and only there. In the window the bar is the page's
	chrome and the film is deliberately sized against it (it is what the window's
	cap squeezes), so it stays a row under the picture. In fullscreen there is no
	page and nothing below to protect: the film takes the whole screen and the bar
	lies over the foot of it, which is also what lets it fade away without the
	picture jumping 52px every time it does.
-->
<div
	role="group"
	aria-label="Playback controls"
	onpointerenter={() => (hovering = true)}
	onpointerleave={() => (hovering = false)}
	onfocusin={(e) => (focusWithin = (e.target as HTMLElement).matches(':focus-visible'))}
	onfocusout={() => (focusWithin = false)}
	class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 {fullscreen
		? 'absolute inset-x-0 bottom-0 bg-vanilla-200/90 transition-opacity duration-300 motion-reduce:transition-none'
		: 'bg-vanilla-200'} {chromeHidden ? 'pointer-events-none opacity-0' : 'opacity-100'}"
	data-testid="controls"
	data-chrome-hidden={chromeHidden}
>
	<button
		onclick={onToggle}
		class="order-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-tangerine-500 text-moonstone-900 transition hover:bg-tangerine-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-moonstone-500 sm:order-1"
		title={playing ? 'Pause (space)' : 'Play (space)'}
		aria-label={playing ? 'Pause' : 'Play'}
		data-testid="play"
	>
		{#if playing}
			<svg class="h-4 w-4" viewBox="0 0 12 14" fill="currentColor" aria-hidden="true">
				<rect x="0" y="0" width="4" height="14" rx="1" />
				<rect x="8" y="0" width="4" height="14" rx="1" />
			</svg>
		{:else}
			<svg class="ml-0.5 h-4 w-4" viewBox="0 0 12 14" fill="currentColor" aria-hidden="true">
				<path d="M0 1.2C0 .4.9-.1 1.5.3l10 4.8c.7.4.7 1.4 0 1.8l-10 4.8c-.6.4-1.5-.1-1.5-.9z" />
			</svg>
		{/if}
	</button>

	<span
		class="order-3 shrink-0 font-mono text-sm tabular-nums text-moonstone-900 sm:order-2"
		data-testid="elapsed"
	>
		{elapsed}
	</span>

	<!-- Only once the two timestamps are neighbours does the pair need reading as one. -->
	<span class="order-3 -mx-1.5 text-sm text-moonstone-800 sm:hidden" aria-hidden="true">/</span>

	<!--
		`basis-full` and not `w-full`: a flex child at 100% width still shrinks to
		share a line with its siblings, while a 100% basis overflows the line it is
		offered and so is given one of its own. `min-w-0` is what lets it shrink on
		the wide layout at all - a range input's ~129px intrinsic width is a floor
		that flex-1 alone will not go under, and that floor is what pushed the rest
		of the bar off the end rather than squeezing this.
	-->
	<input
		type="range"
		min="0"
		max={duration || 0}
		step="0.1"
		value={shownTime}
		oninput={(e) => (scrubbing = Number((e.target as HTMLInputElement).value))}
		onchange={commitSeek}
		disabled={!duration}
		style="--progress: {progress}%"
		class="seek order-1 h-1.5 basis-full cursor-pointer disabled:cursor-default disabled:opacity-50 sm:order-3 sm:min-w-0 sm:flex-1 sm:basis-0"
		aria-label="Seek"
		data-testid="seek"
	/>

	<span
		class="order-4 shrink-0 font-mono text-sm tabular-nums text-moonstone-800"
		data-testid="duration"
	>
		{total}
	</span>

	<!--
		`ml-auto` only while wrapped: on the two-row layout this group and
		fullscreen sit at the far end of the button row, away from the timestamps.
		Inline there is no slack to distribute, so it does nothing either way.
	-->
	<div class="order-5 ml-auto flex shrink-0 items-center gap-1.5 sm:ml-0">
		<button
			onclick={toggleMute}
			class="flex h-8 w-8 items-center justify-center rounded text-moonstone-900 transition hover:bg-vanilla-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-moonstone-500"
			title={muted || volume === 0 ? 'Unmute (m)' : 'Mute (m)'}
			aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
			data-testid="mute"
		>
			<svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
				<path
					d="M7 2.2 3.6 5H1.2C.5 5 0 5.5 0 6.2v3.6c0 .7.5 1.2 1.2 1.2h2.4L7 13.8c.5.4 1.2 0 1.2-.6V2.8c0-.6-.7-1-1.2-.6z"
				/>
				{#if muted || volume === 0}
					<path
						d="M11 6l3.5 3.5M14.5 6L11 9.5"
						stroke="currentColor"
						stroke-width="1.4"
						stroke-linecap="round"
						fill="none"
					/>
				{:else}
					<path
						d="M10.6 5.4a3.7 3.7 0 0 1 0 5.2M12.8 3.2a6.8 6.8 0 0 1 0 9.6"
						stroke="currentColor"
						stroke-width="1.4"
						stroke-linecap="round"
						fill="none"
					/>
				{/if}
			</svg>
		</button>
		<!--
			Withheld on the narrow layout, and the first thing to go rather than the
			last: 80px of slider is the difference between fullscreen fitting and not,
			and it is the least of the bar. A phone has hardware volume keys, and on
			iOS `video.volume` is read-only outright - the slider would move and
			nothing would happen. Mute stays, because that is the one thing the
			hardware keys do not do, and the `m` shortcut still reaches it.
		-->
		<input
			type="range"
			min="0"
			max="1"
			step="0.05"
			value={muted ? 0 : volume}
			oninput={onVolumeInput}
			style="--progress: {(muted ? 0 : volume) * 100}%"
			class="seek hidden h-1.5 w-20 cursor-pointer sm:block"
			aria-label="Volume"
			data-testid="volume"
		/>
	</div>

	<button
		onclick={toggleFullscreen}
		class="order-6 flex h-8 w-8 shrink-0 items-center justify-center rounded text-moonstone-900 transition hover:bg-vanilla-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-moonstone-500"
		title={fullscreen ? 'Exit fullscreen (f)' : 'Fullscreen (f)'}
		aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
		data-testid="fullscreen"
	>
		<svg
			class="h-4 w-4"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			stroke-width="1.6"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			{#if fullscreen}
				<path d="M6 1v5H1M10 15v-5h5" />
			{:else}
				<path d="M1 6V1h5M15 10v5h-5" />
			{/if}
		</svg>
	</button>
</div>

<style>
	/**
	 * A range input cannot show a filled track natively across browsers, and
	 * `accent-color` gives no say over the thumb's size, which is the part you
	 * actually have to hit while a film is playing.
	 */
	.seek {
		-webkit-appearance: none;
		appearance: none;
		background: linear-gradient(
			to right,
			theme('colors.tangerine.600') var(--progress, 0%),
			theme('colors.moonstone.200') var(--progress, 0%)
		);
		border-radius: 9999px;
		outline: none;
	}

	.seek:focus-visible {
		outline: 2px solid theme('colors.moonstone.500');
		outline-offset: 3px;
	}

	.seek::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 14px;
		height: 14px;
		border-radius: 9999px;
		background: theme('colors.tangerine.700');
		border: 2px solid theme('colors.vanilla.100');
		cursor: pointer;
	}

	.seek::-moz-range-thumb {
		width: 14px;
		height: 14px;
		border-radius: 9999px;
		background: theme('colors.tangerine.700');
		border: 2px solid theme('colors.vanilla.100');
		cursor: pointer;
	}

	.seek:disabled::-webkit-slider-thumb {
		background: theme('colors.moonstone.300');
		cursor: default;
	}

	.seek:disabled::-moz-range-thumb {
		background: theme('colors.moonstone.300');
		cursor: default;
	}
</style>
