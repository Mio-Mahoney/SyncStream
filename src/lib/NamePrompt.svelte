<script lang="ts">
	/**
	 * "What should we call you?", asked of a guest the first time they arrive.
	 *
	 * Asked, not required: the room is already connecting behind this, and the
	 * film already loading, under the guest's fallback name (identity.ts). The
	 * answer goes out as a rename, so a guest who takes their time costs the
	 * room nothing, and one who skips is the Guest NNN this app always had.
	 *
	 * A native modal <dialog> for the focus trap, the backdrop and Escape, which
	 * it raises as `cancel` and this treats as a skip.
	 */

	import { NAME_MAX, normalizeName } from '$lib/identity';
	import { onMount } from 'svelte';

	let {
		onName,
		onSkip
	}: {
		/** Normalized and non-empty. */
		onName: (name: string) => void;
		/** Closed without a name: the skip button, or Escape. */
		onSkip: () => void;
	} = $props();

	let dialog = $state<HTMLDialogElement>();
	let draft = $state('');
	const name = $derived(normalizeName(draft));

	onMount(() => dialog?.showModal());

	function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!name) return;
		dialog?.close();
		onName(name);
	}
</script>

<dialog
	bind:this={dialog}
	oncancel={(e) => {
		e.preventDefault();
		dialog?.close();
		onSkip();
	}}
	aria-labelledby="name-prompt-title"
	data-testid="name-prompt"
	class="w-[calc(100%-2rem)] max-w-sm rounded-xl border border-moonstone-200 bg-vanilla-100 p-6 text-moonstone-900 shadow-lg backdrop:bg-moonstone-900/40"
>
	<form onsubmit={submit}>
		<h2 id="name-prompt-title" class="text-lg font-medium">What should we call you?</h2>
		<p class="mt-1 text-sm text-moonstone-800">This is how the others in the room will see you.</p>
		<label class="sr-only" for="name-prompt-field">Your name</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			id="name-prompt-field"
			bind:value={draft}
			maxlength={NAME_MAX}
			autocomplete="nickname"
			spellcheck="false"
			autofocus
			placeholder="Your name"
			data-testid="name-prompt-field"
			class="mt-4 w-full rounded border border-moonstone-400 bg-white px-3 py-2 outline-none focus:border-moonstone-500"
		/>
		<div class="mt-5 flex items-center justify-end gap-3">
			<button
				type="button"
				onclick={() => {
					dialog?.close();
					onSkip();
				}}
				data-testid="name-prompt-skip"
				class="rounded px-2 py-2 text-sm text-moonstone-800 underline decoration-moonstone-400 underline-offset-2 transition hover:text-moonstone-900 focus-visible:ring-2 focus-visible:ring-moonstone-500 focus-visible:outline-none"
			>
				Skip
			</button>
			<button
				type="submit"
				disabled={!name}
				data-testid="name-prompt-save"
				class="rounded border border-tangerine-600 bg-tangerine-400 px-4 py-2 transition hover:bg-tangerine-500 active:bg-tangerine-600 disabled:cursor-default disabled:opacity-50 disabled:hover:bg-tangerine-400"
			>
				Join
			</button>
		</div>
	</form>
</dialog>
