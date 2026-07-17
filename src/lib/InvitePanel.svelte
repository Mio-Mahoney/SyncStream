<script lang="ts">
	/**
	 * The host's half of the wait, and the counterpart to WaitingRoom.
	 *
	 * A host who has just opened a room is doing two things at once: finding a
	 * file, and getting people in. The picker speaks for the first. Nothing spoke
	 * for the second - the invite was a small button in the far corner, and the
	 * arrivals it was supposed to produce were invisible until playback started,
	 * so a host waiting for friends had no way to tell whether to keep waiting or
	 * start without them.
	 */

	type Guest = { peerId: string; name: string };

	let {
		shareUrl,
		guests
	}: {
		shareUrl: string;
		guests: readonly Guest[];
	} = $props();

	let field = $state<HTMLInputElement>();
	let copied = $state(false);
	let manual = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Selected before the write, not after it fails: that way the fallback is
	 * already in place whichever way the write goes. The clipboard is refused
	 * more often than it looks - an unfocused document, a permissions policy, or
	 * any origin that is not secure all reject, and `navigator.clipboard` is not
	 * even defined on the last of those. A button that silently does nothing
	 * would leave the host with no way to invite anyone at all, so the link is on
	 * screen to be read and selected regardless of what the browser allows.
	 */
	async function copy() {
		field?.select();
		try {
			await navigator.clipboard.writeText(shareUrl);
		} catch {
			manual = true;
			return;
		}
		manual = false;
		copied = true;
		// Without this, a second press lands under the first press's pending
		// timer and "Copied" clears early, reading as though the copy failed.
		clearTimeout(timer);
		timer = setTimeout(() => (copied = false), 1500);
	}

	/**
	 * Names rather than a count. "1 watching" is a number a host has to trust;
	 * "Guest 412 is here" is the same fact with the evidence attached, and it is
	 * what tells them the link they just sent actually worked.
	 */
	function presence(names: readonly string[]): string {
		if (names.length === 0) return 'No one has joined yet.';
		if (names.length === 1) return `${names[0]} is here.`;
		if (names.length === 2) return `${names[0]} and ${names[1]} are here.`;
		const others = names.length - 2;
		return `${names[0]}, ${names[1]} and ${others} ${others === 1 ? 'other' : 'others'} are here.`;
	}

	const here = $derived(presence(guests.map((g) => g.name)));
</script>

<section
	class="mb-4 w-full max-w-xl rounded-xl border border-moonstone-200 bg-white/70 p-6"
	data-testid="invite-panel"
>
	<h2 class="text-lg font-medium">Invite people</h2>
	<p class="mt-1 text-sm text-moonstone-800">
		Send this link. It opens the room straight away, with no code to type. It works now - they can
		arrive while you pick a video.
	</p>

	<div class="mt-4 flex gap-2">
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
		<button
			onclick={copy}
			class="shrink-0 rounded border border-tangerine-600 bg-tangerine-400 px-4 py-2 transition hover:bg-tangerine-500 active:bg-tangerine-600"
			data-testid="copy-link">{copied ? 'Copied' : 'Copy'}</button
		>
	</div>

	{#if manual}
		<p class="mt-2 text-sm text-tangerine-800" role="alert" data-testid="copy-manual">
			The browser would not let the page reach the clipboard. The link is selected - press Ctrl+C
			(⌘C on a Mac).
		</p>
	{/if}

	<p
		class="mt-5 flex items-center gap-2 border-t border-moonstone-100 pt-4 text-sm text-moonstone-800"
		data-testid="invite-guests"
	>
		<span
			class="h-2 w-2 shrink-0 rounded-full {guests.length
				? 'bg-moonstone-500'
				: 'bg-moonstone-200'}"
			aria-hidden="true"
		></span>
		{here}
	</p>
</section>
