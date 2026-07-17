<script lang="ts">
	/**
	 * Who is in the room, by name, with a dot that is lit when anyone is.
	 *
	 * Shared between the invite panel and the bar under the player, because the
	 * host is asking the same question on both screens and the answer used to
	 * change shape between them: names before the film, a bare "1 watching"
	 * during it.
	 *
	 * `reader` is which end of the room is reading, and it picks the sentence
	 * rather than the caller doing it: the same roster means "your link worked"
	 * to a host and "these are the people you came for" to a guest, and a
	 * sentence written for one of them is not safe in front of the other.
	 */

	import { presence, watching } from '$lib/invite';

	let {
		names,
		testid,
		reader = 'host'
	}: {
		/** Everyone in the room but the reader, by name. */
		names: readonly string[];
		testid: string;
		reader?: 'host' | 'guest';
	} = $props();

	const here = $derived(reader === 'host' ? presence(names) : watching(names));
</script>

{#if here}
	<p class="flex items-center gap-2 text-sm text-moonstone-800" data-testid={testid}>
		<span
			class="h-2 w-2 shrink-0 rounded-full {names.length ? 'bg-moonstone-500' : 'bg-moonstone-200'}"
			aria-hidden="true"
		></span>
		{here}
	</p>
{/if}
