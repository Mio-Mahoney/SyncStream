<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	/**
	 * Every dead end that is not a room's own.
	 *
	 * A room with a bad code, a room nobody is hosting and a room that ended all
	 * have a screen already (WaitingRoom), because the room page is what loads
	 * for them. This is what is left: an address that matches no route at all,
	 * and the rare failure of the page itself. Without it both got SvelteKit's
	 * bare "404 Not Found", which reads as the site being broken rather than the
	 * link.
	 *
	 * Built to the same card as WaitingRoom's dead ends on purpose. To the person
	 * holding the link it is the same situation - the film is not going to play
	 * from here, now what? - and it should not look like a different product
	 * answering.
	 */
	const missing = $derived(page.status === 404);
	const title = $derived(missing ? 'Page not found' : 'Something went wrong');
</script>

<svelte:head>
	<title>{title} - SyncStream</title>
</svelte:head>

<main class="flex min-h-screen flex-col items-center px-4 py-6 font-sans">
	<section
		class="mt-12 w-full max-w-md rounded-xl border border-moonstone-200 bg-white/70 p-8 text-center"
		data-testid="error-page"
		data-status={page.status}
	>
		{#if missing}
			<h1 class="text-lg font-medium" data-testid="error-title">There's nothing at this address</h1>
			<p class="mx-auto mt-2 max-w-[20rem] text-sm text-moonstone-800">
				SyncStream is a start page and the rooms people open from it, and this address is neither.
				If someone sent you here to watch something, ask them for the invite link again.
			</p>
		{:else}
			<!--
				Not worded as the reader's mistake, and not as the room's: nothing
				here knows which room, if any, they were in. Reloading is offered
				first because it is what fixes the one cause this realistically has -
				a tab left open across a deploy, asking for files that were replaced.
			-->
			<h1 class="text-lg font-medium" data-testid="error-title">Something went wrong</h1>
			<p class="mx-auto mt-2 max-w-[20rem] text-sm text-moonstone-800">
				The page hit a problem it couldn't recover from. Reloading usually clears it.
			</p>
		{/if}

		<div class="mt-6 flex justify-center gap-3">
			{#if !missing}
				<button
					onclick={() => location.reload()}
					class="rounded border border-tangerine-600 bg-tangerine-400 px-4 py-2 transition hover:bg-tangerine-500 active:bg-tangerine-600"
					data-testid="reload">Reload</button
				>
			{/if}
			<a
				href={resolve('/')}
				class="rounded border bg-moonstone-100 px-4 py-2 transition hover:bg-moonstone-200 active:bg-moonstone-300"
				data-testid="go-home">Back to start</a
			>
		</div>

		{#if !missing && page.error?.message}
			<!-- Worth keeping for a bug report, worth hiding from someone here for a film. -->
			<details class="mt-6 text-left">
				<summary class="cursor-pointer text-center text-xs text-moonstone-700">
					Error details
				</summary>
				<p
					class="mt-2 font-mono text-xs break-words text-moonstone-700"
					data-testid="error-details"
				>
					{page.status}: {page.error.message}
				</p>
			</details>
		{/if}
	</section>
</main>
