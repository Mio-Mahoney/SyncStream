<script lang="ts">
	/**
	 * Why the film just stopped, addressed to whoever is reading it.
	 *
	 * The readiness barrier pauses everyone when one guest runs out of buffer,
	 * so this is the only account anybody gets of a film that froze on its own.
	 * It used to be one sentence for two very different readers - and it named
	 * nobody at all, because the host looked its own guests up by name in a map
	 * keyed by id, so every banner read "Waiting for a guest".
	 *
	 * The guest who is behind gets the extra line. Everyone else is being told
	 * about someone else's connection and can only wait; that guest is watching
	 * their own film stop with no control on screen that would restart it, and
	 * the one thing they need to know is that none of this needs them to act.
	 *
	 * `started` is the other split, and it is the one this banner was missing.
	 * The barrier also holds the room before anybody has watched anything: a
	 * guest arrives with an empty buffer, which is simply the way in. There the
	 * "fell behind" copy is false in every clause, and it was the first thing
	 * every new guest read.
	 *
	 * It renders over the film rather than under it, which is what puts it in
	 * front of the one reader who most needs it: fullscreen is how a film gets
	 * watched, and the fullscreen element is the player. A sibling of the player
	 * is not painted at all while that is up, so this whole banner - copy,
	 * glyph, and the "you don't need to do anything" that keeps a stalled guest
	 * from reloading - was withheld from exactly the person whose screen had
	 * just gone black.
	 */

	import { waitingMessage } from '$lib/barrier';

	let {
		on,
		you,
		started
	}: {
		/** The guests being waited on, never including the reader. */
		on: readonly string[];
		/** The reader is one of the guests being waited on. */
		you: boolean;
		/** The film has played for this reader already, so a stall really is one. */
		started: boolean;
	} = $props();

	const message = $derived(waitingMessage(on, you, started));
</script>

<!--
	Centred on the film, and over it. The film is stopped - that is the whole
	premise of the banner - so there is nothing underneath worth protecting, and
	the middle of a picture that has just frozen is where the eye already is.

	`pointer-events-none` because nothing here is a control, and the bar below it
	is: the overlay spans the player so that it centres, which would otherwise
	make it a 1024px shield over the play button.
-->
<div class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">
	<div
		class="flex max-h-full items-start gap-3 overflow-y-auto rounded bg-vanilla-500 px-4 py-3 shadow-lg"
		role="status"
		data-testid="waiting"
		data-you={you}
		data-started={started}
	>
		{#if started}
			<!--
				A pause glyph rather than a spinner: the room is stopped, not working on
				something, and a spinner would promise progress that only a recovering
				connection can make.
			-->
			<svg class="mt-1 h-4 w-4 shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
				<rect x="4" y="3" width="3" height="10" rx="1" />
				<rect x="9" y="3" width="3" height="10" rx="1" />
			</svg>
		{:else}
			<!--
				The same reasoning inverted. Nothing has stopped here - the film is on its
				way and this clears itself within seconds of it arriving - so the glyph is
				the one the rest of the app uses for a wait that is going somewhere. A
				pause glyph would report the opening buffer as a halted room.
			-->
			<div
				class="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-moonstone-200 border-t-tangerine-500"
				aria-hidden="true"
			></div>
		{/if}
		<div>
			<p>{message}</p>
			{#if you}
				<p class="mt-1 text-sm text-moonstone-800" data-testid="waiting-you">
					{#if started}
						Your connection fell behind. The film starts again on its own once it catches up - you
						don't need to do anything.
					{:else}
						The film starts on its own once enough of it has arrived - you don't need to do
						anything.
					{/if}
				</p>
			{/if}
		</div>
	</div>
</div>
