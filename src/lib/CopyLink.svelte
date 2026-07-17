<script lang="ts">
	/**
	 * The invite link and the one button that copies it.
	 *
	 * Shared because the host needs the link twice - before the film, to fill the
	 * room, and during it, to let a latecomer in - and the second copy of this
	 * used to be a corner button that swallowed every failure. The clipboard is
	 * refused more often than it looks: an unfocused document, a permissions
	 * policy, or any origin that is not secure all reject, and
	 * `navigator.clipboard` is not even defined on the last of those. So a
	 * refusal has to leave a link on screen that can be read and selected by
	 * hand, or the host cannot invite anyone at all.
	 *
	 * `variant` is only about how much room the link is given, never about
	 * whether the fallback exists:
	 *   panel   - the link is always on screen. This IS the invite screen.
	 *   compact - the button alone until a refusal reveals the link, so the bar
	 *             under a playing video does not carry a URL field it does not
	 *             need.
	 */

	import { tick } from 'svelte';

	let {
		shareUrl,
		variant = 'panel',
		label = 'Copy'
	}: {
		shareUrl: string;
		variant?: 'panel' | 'compact';
		label?: string;
	} = $props();

	let field = $state<HTMLInputElement>();
	let copied = $state(false);
	let manual = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	/** The link is on screen whenever it could be needed to recover by hand. */
	const showField = $derived(variant === 'panel' || manual);

	/**
	 * Selected before the write, not after it fails: that way the fallback is
	 * already in place whichever way the write goes. In `compact` the field does
	 * not exist yet at that point, so the selection is retried once the reveal
	 * has rendered.
	 */
	async function copy() {
		field?.select();
		try {
			await navigator.clipboard.writeText(shareUrl);
		} catch {
			manual = true;
			// The compact field only mounts with this flag, so it cannot be
			// selected until Svelte has flushed the reveal.
			await tick();
			field?.focus();
			field?.select();
			return;
		}
		manual = false;
		copied = true;
		// Without this, a second press lands under the first press's pending timer
		// and "Copied" clears early, reading as though the copy failed.
		clearTimeout(timer);
		timer = setTimeout(() => (copied = false), 1500);
	}
</script>

<div class="flex gap-2">
	{#if showField}
		<!--
			Readonly rather than static text: a link you cannot select is a link you
			cannot copy when the clipboard button is refused.
		-->
		<input
			bind:this={field}
			value={shareUrl}
			readonly
			aria-label="Invite link"
			onfocus={(e) => e.currentTarget.select()}
			class="min-w-0 flex-1 rounded border border-moonstone-300 bg-white/75 px-3 py-2 font-mono text-sm outline-none focus:border-moonstone-500"
			data-testid="invite-link"
		/>
	{/if}
	<button
		onclick={copy}
		class="shrink-0 rounded border border-tangerine-600 bg-tangerine-400 transition hover:bg-tangerine-500 active:bg-tangerine-600 {variant ===
		'panel'
			? 'px-4 py-2'
			: 'px-3 py-1 text-sm'}"
		data-testid="copy-link">{copied ? 'Copied' : label}</button
	>
</div>

{#if manual}
	<p class="mt-2 text-sm text-tangerine-800" role="alert" data-testid="copy-manual">
		The browser would not let the page reach the clipboard. The link is selected - press Ctrl+C (⌘C
		on a Mac).
	</p>
{/if}
