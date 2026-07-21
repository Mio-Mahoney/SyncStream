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
	import { STRATEGY_PARAM, strategyFromParams } from '$lib/rendezvous/room';

	let roomCode = $state('');
	let error = $state('');

	const canJoin = $derived(isValidRoomCode(roomCode));

	/**
	 * A valid `?s=` on this page rides along to the room, as `&s=...` or
	 * `?s=...` per what precedes it. The room page is where the strategy is
	 * read, and this page sits in front of it: without the forward, opening the
	 * app with a strategy pinned (the e2e suite pinning `local`, or someone
	 * reproducing a relay bug with `nostr`) would shed it on the first click.
	 * Validated rather than passed through, so a garbage value dies here
	 * instead of riding into every URL the room mints.
	 */
	function strategyCarry(hasQuery: boolean): string {
		const s = strategyFromParams(page.url.searchParams);
		return s ? `${hasQuery ? '&' : '?'}${STRATEGY_PARAM}=${s}` : '';
	}

	function join() {
		if (!canJoin) {
			error = `Room codes are ${CODE_LENGTH} characters.`;
			return;
		}
		const path = resolve('/room/[id]', { id: roomCode });
		// The path IS resolved. The rule only recognises a bare resolve() call and
		// cannot see through appending a query string to one.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		goto(`${path}${strategyCarry(false)}`);
	}

	function createRoom() {
		// `create` is what distinguishes hosting from joining. The share link the
		// host copies never carries it, so a guest opening that link can never
		// race the host for the same code. It has to survive a reload, so it is a
		// query param rather than navigation state: a host who refreshes must
		// still be the host, or the room dies under them.
		const path = resolve('/room/[id]', { id: generateRoomCode() });
		// The path IS resolved. The rule only recognises a bare resolve() call and
		// cannot see through appending a query string to one.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		goto(`${path}?create=1${strategyCarry(true)}`);
	}

	/**
	 * What the host shares is a link, so a link is what lands in this box. Read
	 * the code out of it rather than letting `normalizeRoomCode` shred the URL
	 * into six alphabet characters that pass validation and lead nowhere.
	 */
	function onInput() {
		error = '';
		if (looksLikeLink(roomCode)) {
			const fromLink = roomCodeFromLink(roomCode);
			if (fromLink) {
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
	<title>SyncStream</title>
	<meta
		name="description"
		content="Watch a local video together, in sync, with no upload and no server."
	/>
</svelte:head>

<main class="flex min-h-screen flex-col items-center justify-center px-6 py-12 font-sans">
	<h1 class="mb-3 text-center text-5xl">SyncStream</h1>
	<p class="mb-10 max-w-md text-center text-moonstone-800">
		Play a video off your own disk and watch it together, in sync. Nothing uploads anywhere.
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
