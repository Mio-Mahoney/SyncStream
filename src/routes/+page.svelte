<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		generateRoomCode,
		isValidRoomCode,
		looksLikeLink,
		normalizeRoomCode,
		roomCodeFromLink,
		CODE_LENGTH
	} from '$lib/rendezvous/codes';
	import { roomQuery, strategyFromLink, strategyFromParams } from '$lib/rendezvous/room';
	import type { StrategyName } from '$lib/rendezvous/transport';
	import { DESCRIPTION } from '$lib/copy';

	let roomCode = $state('');
	let error = $state('');

	const canJoin = $derived(isValidRoomCode(roomCode));

	/**
	 * The strategy the last pasted link named. Cleared by any edit that is not a
	 * link: a code typed over it may be for another room, and a strategy is only
	 * known for the room whose link said so.
	 */
	let linkStrategy = $state<StrategyName | undefined>();

	/**
	 * Goes to a room, at the same address its invite link has (`hooks.ts`), so a
	 * room has one address however it was entered.
	 *
	 * A strategy rides along: the one a pasted link named, or else a valid `?s=`
	 * on this page. The room page is where it is read, and this page sits in
	 * front of it - without the forward, opening the app with a strategy pinned
	 * (the e2e suite pinning `local`, or someone reproducing a relay bug with
	 * `nostr`) would shed it on the first click. Validated rather than passed
	 * through, so a garbage value dies here instead of riding into every URL the
	 * room mints.
	 */
	function enter(code: string, opts: { create?: boolean; strategy?: StrategyName } = {}) {
		const strategy = opts.strategy ?? strategyFromParams(page.url.searchParams);
		// The path IS resolved. The rule only recognises a bare resolve() call and
		// cannot see through appending a query string to one.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		goto(`${resolve('/')}${roomQuery(code, { create: opts.create, strategy })}`);
	}

	function join() {
		if (!canJoin) {
			error = `Room codes are ${CODE_LENGTH} characters.`;
			return;
		}
		enter(roomCode, { strategy: linkStrategy });
	}

	function createRoom() {
		// `create` is what distinguishes hosting from joining. The share link the
		// host copies never carries it, so a guest opening that link can never
		// race the host for the same code. It has to survive a reload, so it is a
		// query param rather than navigation state: a host who refreshes must
		// still be the host, or the room dies under them.
		enter(generateRoomCode(), { create: true });
	}

	/**
	 * What the host shares is a link, so a link is what lands in this box. Read
	 * the code out of it rather than letting `normalizeRoomCode` shred the URL
	 * into six alphabet characters that pass validation and lead nowhere.
	 */
	function onInput() {
		error = '';
		linkStrategy = undefined;
		if (looksLikeLink(roomCode)) {
			const fromLink = roomCodeFromLink(roomCode);
			if (fromLink) {
				linkStrategy = strategyFromLink(roomCode);
				roomCode = fromLink;
				return;
			}
			// Better to say so than to silently keep the salvageable-looking
			// letters and send them into an empty room.
			roomCode = '';
			error = 'That link has no room code in it. Check you copied the whole thing.';
			return;
		}
		roomCode = normalizeRoomCode(roomCode);
	}
</script>

<svelte:head>
	<!-- The description is in app.html, where a crawler that runs no script can read it. -->
	<title>SyncStream</title>
</svelte:head>

<main class="flex min-h-screen flex-col items-center justify-center px-6 py-12 font-sans">
	<h1 class="mb-3 text-center text-5xl">SyncStream</h1>
	<p class="mb-10 max-w-md text-center text-moonstone-800">
		{DESCRIPTION}
	</p>

	<div class="w-full max-w-sm">
		<!--
			Hosting is the action a first-time visitor is here for; joining needs a
			code they can only have been given. They used to sit side by side at
			equal weight under a code box that dominated the page, which read as
			"enter a code" being the way in.
		-->
		<section class="rounded-xl border border-moonstone-200 bg-white/70 p-6 text-center">
			<h2 class="text-lg font-medium">Start a watch party</h2>
			<p class="mx-auto mt-1 mb-5 max-w-[16rem] text-sm text-moonstone-800">
				Open a room, pick a video, and invite people with a link.
			</p>
			<button
				class="w-full rounded border border-tangerine-600 bg-tangerine-400 px-4 py-3 text-xl transition hover:bg-tangerine-500 active:bg-tangerine-600"
				onclick={createRoom}>Create room</button
			>
		</section>

		<div class="my-5 flex items-center gap-3 text-sm text-moonstone-700">
			<span class="h-px flex-1 bg-moonstone-200"></span>
			<span>or join one</span>
			<span class="h-px flex-1 bg-moonstone-200"></span>
		</div>

		<section class="rounded-xl border border-moonstone-200 bg-white/70 p-6">
			<label for="room-code" class="block text-center text-sm text-moonstone-800">
				Enter the code, or paste the invite link
			</label>
			<input
				id="room-code"
				bind:value={roomCode}
				oninput={onInput}
				onkeydown={(e) => e.key === 'Enter' && join()}
				placeholder={'·'.repeat(CODE_LENGTH)}
				aria-label="Room code"
				aria-invalid={error ? 'true' : undefined}
				autocapitalize="characters"
				autocomplete="off"
				spellcheck="false"
				class="mt-3 h-[64px] w-full rounded border-2 border-slate-400 bg-white/75 text-center font-mono text-[32px] tracking-[0.3em] outline-none focus:border-moonstone-500 focus:bg-white focus:placeholder-transparent"
			/>
			<!-- Belongs against the field it is about, not at the foot of the page. -->
			{#if error}
				<p
					class="mt-2 text-center text-sm text-tangerine-800"
					role="alert"
					data-testid="join-error"
				>
					{error}
				</p>
			{/if}
			<button
				onclick={join}
				disabled={!canJoin}
				class="mt-3 w-full rounded border bg-moonstone-100 px-4 py-2 text-xl transition hover:bg-moonstone-200 active:bg-moonstone-300 disabled:opacity-40 disabled:hover:bg-moonstone-100"
				>Join</button
			>
		</section>
	</div>
</main>
