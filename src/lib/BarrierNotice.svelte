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
	 */

	import { waitingMessage } from '$lib/barrier';

	let {
		on,
		you
	}: {
		/** The guests being waited on, never including the reader. */
		on: readonly string[];
		/** The reader is one of the guests being waited on. */
		you: boolean;
	} = $props();

	const message = $derived(waitingMessage(on, you));
</script>

<div
	class="mt-3 rounded bg-vanilla-500 px-4 py-3"
	role="status"
	data-testid="waiting"
	data-you={you}
>
	<p class="flex items-center gap-2">
		<!--
			A pause glyph rather than a spinner: the room is stopped, not working on
			something, and a spinner would promise progress that only a recovering
			connection can make.
		-->
		<svg class="h-4 w-4 shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			<rect x="4" y="3" width="3" height="10" rx="1" />
			<rect x="9" y="3" width="3" height="10" rx="1" />
		</svg>
		{message}
	</p>
	{#if you}
		<p class="mt-1 text-sm text-moonstone-800" data-testid="waiting-you">
			Your connection fell behind. The film starts again on its own once it catches up - you don't
			need to do anything.
		</p>
	{/if}
</div>
