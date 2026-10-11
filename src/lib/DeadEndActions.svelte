<script lang="ts">
	import { resolve } from '$app/paths';

	/**
	 * The way out of a dead end, on whichever StatusCard is one.
	 *
	 * Every dead end used to be a line of text and nothing else: the only way
	 * out was editing the URL. "Back to start" is therefore always here. `retry`
	 * is only for a dead end that doing the same thing again can actually get
	 * past - where it cannot, the button would be a lie.
	 */
	let {
		retry
	}: {
		retry?: { label: string; testid: string; onclick: () => void };
	} = $props();
</script>

<div class="mt-6 flex justify-center gap-3">
	{#if retry}
		<button
			onclick={retry.onclick}
			class="rounded border border-tangerine-600 bg-tangerine-400 px-4 py-2 transition hover:bg-tangerine-500 active:bg-tangerine-600"
			data-testid={retry.testid}>{retry.label}</button
		>
	{/if}
	<a
		href={resolve('/')}
		class="rounded border bg-moonstone-100 px-4 py-2 transition hover:bg-moonstone-200 active:bg-moonstone-300"
		data-testid="go-home">Back to start</a
	>
</div>
