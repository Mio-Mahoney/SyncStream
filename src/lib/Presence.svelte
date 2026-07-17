<script lang="ts">
	/**
	 * Who is in the room, by name, with a dot that is lit when anyone is.
	 *
	 * Shared between the invite panel and the bar under the player, because the
	 * host is asking the same question on both screens and the answer used to
	 * change shape between them: names before the film, a bare "1 watching"
	 * during it.
	 */

	import { presence } from '$lib/invite';

	let {
		guests,
		testid
	}: {
		guests: readonly { peerId: string; name: string }[];
		testid: string;
	} = $props();

	const here = $derived(presence(guests.map((g) => g.name)));
</script>

<p class="flex items-center gap-2 text-sm text-moonstone-800" data-testid={testid}>
	<span
		class="h-2 w-2 shrink-0 rounded-full {guests.length ? 'bg-moonstone-500' : 'bg-moonstone-200'}"
		aria-hidden="true"
	></span>
	{here}
</p>
