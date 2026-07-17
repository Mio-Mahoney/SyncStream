<script lang="ts">
	import { resolve } from '$app/paths';
	import { CODE_LENGTH } from '$lib/rendezvous/codes';

	/**
	 * Everything a guest sees before there is a video to show.
	 *
	 * The waits below are indistinguishable to a guest from the outside - all of
	 * them are "nothing is happening yet" - but they call for completely
	 * different actions: keep waiting, go get the right code, or leave. Naming
	 * which one you are in is the whole job of this screen.
	 *
	 * `invalid` is the odd one out: nothing was ever attempted, because the code
	 * in the URL could not name a room. It still belongs here rather than in an
	 * error banner, since to the person holding a broken link it is the same
	 * situation as `failed` - the film is not going to play, now what?
	 */
	export type Phase = 'searching' | 'found' | 'failed' | 'ended' | 'invalid';

	let {
		phase,
		code,
		hostName = '',
		/** Per-strategy diagnostics from a RendezvousError, for a `failed` phase. */
		attempts = [] as readonly string[],
		onRetry
	}: {
		phase: Phase;
		code: string;
		hostName?: string;
		attempts?: readonly string[];
		onRetry: () => void;
	} = $props();
</script>

<section
	class="mt-12 w-full max-w-md rounded-xl border border-moonstone-200 bg-white/70 p-8 text-center"
	data-testid="waiting-room"
	data-phase={phase}
>
	{#if phase === 'searching' || phase === 'found'}
		<!--
			The spinner is the only thing on this screen that distinguishes "working
			on it" from "hung". Rendezvous walks a ladder of public relays at ten
			seconds a rung, so this can honestly sit here for twenty seconds.
		-->
		<div
			class="mx-auto mb-5 h-8 w-8 animate-spin rounded-full border-[3px] border-moonstone-200 border-t-tangerine-500"
			role="status"
			aria-label="Loading"
		></div>
	{/if}

	{#if phase === 'searching'}
		<h2 class="text-lg font-medium" data-testid="waiting-title">Looking for room {code}</h2>
		<p class="mx-auto mt-2 max-w-[18rem] text-sm text-moonstone-800">
			Finding the host through a relay. This usually takes a few seconds.
		</p>
	{:else if phase === 'found'}
		<!--
			Reached the instant the host says hello, which is well before there is
			anything to play. Saying so is the difference between a guest who waits
			and one who assumes the code was wrong and re-types it.
		-->
		<h2 class="text-lg font-medium" data-testid="waiting-title">You're in</h2>
		<p class="mx-auto mt-2 max-w-[18rem] text-sm text-moonstone-800">
			Connected to {hostName || 'the host'}. The video starts as soon as they pick one.
		</p>
	{:else if phase === 'failed'}
		<h2 class="text-lg font-medium" data-testid="waiting-title">No one is hosting room {code}</h2>
		<p class="mx-auto mt-2 max-w-[20rem] text-sm text-moonstone-800">
			A room only exists while its host has the page open. Check the code, or ask them to send the
			invite link again.
		</p>
	{:else if phase === 'invalid'}
		<!--
			A truncated or mistyped link. Deliberately not phrased as "no one is
			hosting": nothing was looked for, and telling someone their room is
			empty when their link is broken sends them to ask the host to reopen a
			room that is already open.
		-->
		<h2 class="text-lg font-medium" data-testid="waiting-title">That link isn't a room</h2>
		<p class="mx-auto mt-2 max-w-[20rem] text-sm text-moonstone-800">
			Room codes are {CODE_LENGTH} characters, letters and numbers. The one in this address isn't, so
			the link was probably cut short somewhere. Ask the host to send it again.
		</p>
	{:else}
		<h2 class="text-lg font-medium" data-testid="waiting-title">The watch party is over</h2>
		<p class="mx-auto mt-2 max-w-[20rem] text-sm text-moonstone-800">
			The host closed the room. The video was streaming from their computer, so there is nothing
			left to play.
		</p>
	{/if}

	{#if phase === 'failed' || phase === 'ended' || phase === 'invalid'}
		<!--
			Every dead end used to be a line of text and nothing else: the only way
			out was editing the URL. `failed` gets a retry because a host who is
			merely slow to open the room makes it succeed on the second press.
			`invalid` does not - the same broken code cannot start working.
		-->
		<div class="mt-6 flex justify-center gap-3">
			{#if phase === 'failed'}
				<button
					onclick={onRetry}
					class="rounded border border-tangerine-600 bg-tangerine-400 px-4 py-2 transition hover:bg-tangerine-500 active:bg-tangerine-600"
					data-testid="retry">Try again</button
				>
			{/if}
			<a
				href={resolve('/')}
				class="rounded border bg-moonstone-100 px-4 py-2 transition hover:bg-moonstone-200 active:bg-moonstone-300"
				data-testid="go-home">Back to start</a
			>
		</div>
	{/if}

	{#if phase === 'failed' && attempts.length}
		<!--
			The relay-by-relay diagnostic used to BE the error message a guest read.
			It is worth keeping for a bug report and worth hiding from someone who
			just wants to watch a film.
		-->
		<details class="mt-6 text-left">
			<summary class="cursor-pointer text-center text-xs text-moonstone-700">
				Connection details
			</summary>
			<ul class="mt-2 space-y-1 font-mono text-xs break-words text-moonstone-700">
				{#each attempts as attempt (attempt)}
					<li>{attempt}</li>
				{/each}
			</ul>
		</details>
	{/if}
</section>
