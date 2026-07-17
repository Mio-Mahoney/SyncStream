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

<div
	class="mt-3 flex items-start gap-3 rounded bg-vanilla-500 px-4 py-3"
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
					The film starts on its own once enough of it has arrived - you don't need to do anything.
				{/if}
			</p>
		{/if}
	</div>
</div>
