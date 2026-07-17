<script lang="ts">
	import { resolve } from '$app/paths';
	import { CODE_LENGTH } from '$lib/rendezvous/codes';

	/**
	 * The screen for a room with no video on it - mostly a guest's, and every
	 * dead end either end can reach.
	 *
	 * The waits below are indistinguishable from the outside - all of them are
	 * "nothing is happening yet" - but they call for completely different
	 * actions: keep waiting, go get the right code, or leave. Naming which one
	 * you are in is the whole job of this screen.
	 *
	 * `invalid` is the odd one out among the waits: nothing was ever attempted,
	 * because the code in the URL could not name a room. It still belongs here
	 * rather than in an error banner, since to the person holding a broken link
	 * it is the same situation as `failed` - the film is not going to play, now
	 * what?
	 *
	 * `opening` and `unopened` are the host's alone, and they are one wait and
	 * its failure: the announce going out, and the announce never landing.
	 * `unopened` is also the same rendezvous failure as `failed` read from the
	 * other end - the guest found no room to join, the host opened none - and it
	 * lands here for the reason `invalid` does: it is a dead end, and this is the
	 * screen that knows how to end one.
	 */
	export type Phase =
		'searching' | 'found' | 'failed' | 'ended' | 'invalid' | 'rejected' | 'opening' | 'unopened';

	let {
		phase,
		code,
		hostName = '',
		/** Per-strategy diagnostics from a RendezvousError: `failed` or `unopened`. */
		attempts = [] as readonly string[],
		/** The host's probe verdict, for a `rejected` phase. */
		reason = '',
		onRetry
	}: {
		phase: Phase;
		code: string;
		hostName?: string;
		attempts?: readonly string[];
		reason?: string;
		onRetry: () => void;
	} = $props();
</script>

<section
	class="mt-12 w-full max-w-md rounded-xl border border-moonstone-200 bg-white/70 p-8 text-center"
	data-testid="waiting-room"
	data-phase={phase}
>
	{#if phase === 'searching' || phase === 'found' || phase === 'rejected' || phase === 'opening'}
		<!--
			The spinner is the only thing on this screen that distinguishes "working
			on it" from "hung". Rendezvous walks a ladder of public relays at ten
			seconds a rung, so this can honestly sit here for twenty seconds.

			`rejected` keeps it because it is a wait like the others and resolves on
			its own the moment the host picks again - without it the screen reads as
			a dead end, and the guest leaves a room that is about to start.
		-->
		<div
			class="mx-auto mb-5 h-8 w-8 animate-spin rounded-full border-[3px] border-moonstone-200 border-t-tangerine-500"
			role="status"
			aria-label="Loading"
		></div>
	{/if}

	{#if phase === 'opening'}
		<!--
			The host's `searching`, and pointedly the one wait on this screen that
			does NOT name the code. Every other phase leads with it; this one cannot,
			because the code is not settled yet. We draw it ourselves and only find
			out whether it is free by announcing it and seeing whether a rival host
			answers - so until that check clears it is a guess, and a collision
			replaces it with a different one.

			That guess used to be the largest thing on screen, 2xl mono under a "Room"
			label, over an otherwise empty page. Explaining where the code went is the
			last line's job: a host who was looking at one and now is not would
			otherwise assume this is broken.
		-->
		<h2 class="text-lg font-medium" data-testid="waiting-title">Opening your room</h2>
		<p class="mx-auto mt-2 max-w-[18rem] text-sm text-moonstone-800">
			Announcing it through a relay so your friends can find it. This usually takes a few seconds.
		</p>
		<p class="mx-auto mt-2 max-w-[18rem] text-sm text-moonstone-800">
			Your room code and invite link appear as soon as it's live.
		</p>
	{:else if phase === 'searching'}
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
	{:else if phase === 'rejected'}
		<!--
			The host's file was rejected. This used to reach the guest as the host's
			own verdict in a red banner - "The audio track is AC-3 and this browser
			cannot decode it" - which reads, to a guest, as an accusation against
			the browser they are sitting in front of and something they should go
			fix. It is neither: it is the host's file, on the host's machine, and
			the only person who can act is the host. So the fact stays, the blame
			moves, and the detail goes behind a disclosure like every other
			diagnostic on this screen.
		-->
		<h2 class="text-lg font-medium" data-testid="waiting-title">That video won't play</h2>
		<p class="mx-auto mt-2 max-w-[20rem] text-sm text-moonstone-800">
			{hostName || 'The host'} picked a video this app can't play, so nothing has started. They can pick
			another one - you'll stay in the room, and it will start on its own.
		</p>
	{:else if phase === 'failed'}
		<h2 class="text-lg font-medium" data-testid="waiting-title">No one is hosting room {code}</h2>
		<p class="mx-auto mt-2 max-w-[20rem] text-sm text-moonstone-800">
			A room only exists while its host has the page open. Check the code, or ask them to send the
			invite link again.
		</p>
	{:else if phase === 'unopened'}
		<!--
			The host's half of `failed`, and deliberately not worded as it. "No one
			is hosting" is the wrong sentence for the person who was trying to be
			the host: nobody failed to show up, the announce never went out, and
			there is no code to re-check because we drew it ourselves.

			The cause is not claimed outright. A relay that would not answer is what
			this almost always is, but an occupancy collision throws the same error
			with the same emptiness on screen, and the details below say which.
		-->
		<h2 class="text-lg font-medium" data-testid="waiting-title">Couldn't open the room</h2>
		<p class="mx-auto mt-2 max-w-[20rem] text-sm text-moonstone-800">
			A room has to be announced through a public relay before anyone can join it, and that didn't
			get through. Relays come and go, so trying again often works.
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

	{#if phase === 'failed' || phase === 'ended' || phase === 'invalid' || phase === 'unopened'}
		<!--
			Every dead end used to be a line of text and nothing else: the only way
			out was editing the URL. `failed` gets a retry because a host who is
			merely slow to open the room makes it succeed on the second press, and
			`unopened` because the relay that would not answer is not the same relay
			a second attempt reaches. `invalid` gets none - the same broken code
			cannot start working, so the button would be a lie.
		-->
		<div class="mt-6 flex justify-center gap-3">
			{#if phase === 'failed' || phase === 'unopened'}
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

	{#if phase === 'rejected' && reason}
		<details class="mt-6 text-left">
			<summary class="cursor-pointer text-center text-xs text-moonstone-700">
				Why it won't play
			</summary>
			<!--
				Attributed, because the probe writes for the host: "this browser
				cannot decode it" means the host's browser, and unattributed in front
				of a guest it names the wrong machine.
			-->
			<p class="mt-2 text-xs text-moonstone-700">What the host's browser found in the file:</p>
			<p class="mt-1 text-xs break-words text-moonstone-700" data-testid="reject-reason">
				{reason}
			</p>
		</details>
	{/if}

	{#if (phase === 'failed' || phase === 'unopened') && attempts.length}
		<!--
			The relay-by-relay diagnostic used to BE the error message a guest read,
			and the whole of what a host read. It is worth keeping for a bug report
			and worth hiding from someone who just wants to watch a film.
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
