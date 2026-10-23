<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		generateRoomCode,
		generateRoomSecret,
		linkLacksKey,
		roomFromLink,
		roomHash,
		type RoomRef
	} from '$lib/rendezvous/codes';
	import { STRATEGY_PARAM, strategyFromParams } from '$lib/rendezvous/room';

	/** What was pasted, verbatim, so the reader can see and fix it. */
	let link = $state('');
	let error = $state('');

	/**
	 * The room the pasted link names, or null. A link is the only way in: the
	 * room's key (codes.ts) is sixteen characters nobody should be typing, and
	 * the code alone has not opened a room since the key existed. So the box
	 * takes a link and reads the room out of it, rather than taking a code and
	 * mangling a pasted link into six valid-looking letters of one.
	 */
	const room = $derived<RoomRef | null>(roomFromLink(link));
	const canJoin = $derived(room !== null);

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
		if (!room) {
			error = describe(link);
			return;
		}
		const path = resolve('/room/[id]', { id: room.code });
		// The path IS resolved. The rule only recognises a bare resolve() call and
		// cannot see through appending a query string to one.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		goto(`${path}${strategyCarry(false)}${roomHash(room.secret)}`);
	}

	/** Why a pasted string is not a link into a room, said so the reader can fix it. */
	function describe(input: string): string {
		if (!input.trim()) return 'Paste the invite link the host sent you.';
		if (linkLacksKey(input)) {
			return "That link has lost its key - the part after '#'. Ask the host to copy the whole link again.";
		}
		return 'That is not an invite link. Check you copied the whole thing.';
	}

	function createRoom() {
		// `create` is what distinguishes hosting from joining. The share link the
		// host copies never carries it, so a guest opening that link can never
		// race the host for the same code. It has to survive a reload, so it is a
		// query param rather than navigation state: a host who refreshes must
		// still be the host, or the room dies under them.
		const path = resolve('/room/[id]', { id: generateRoomCode() });
		// The key is minted here with the code, so the host's very first URL
		// carries it and a reload keeps it (codes.ts).
		// The path IS resolved. The rule only recognises a bare resolve() call and
		// cannot see through appending a query string to one.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		goto(`${path}?create=1${strategyCarry(true)}${roomHash(generateRoomSecret())}`);
	}

	/**
	 * Said as the reader types, not only on Join: a link that lost its ending
	 * to a chat client looks complete, and the difference between "not a link"
	 * and "a link missing its key" is the difference between re-copying and
	 * asking the host for it.
	 */
	function onInput() {
		error = link.trim() && !room ? describe(link) : '';
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
			<label for="invite-link" class="block text-center text-sm text-moonstone-800">
				Paste the invite link
			</label>
			<input
				id="invite-link"
				bind:value={link}
				oninput={onInput}
				onkeydown={(e) => e.key === 'Enter' && join()}
				placeholder="https://…/room/K7M4PQ#k=…"
				aria-label="Invite link"
				aria-invalid={error ? 'true' : undefined}
				autocapitalize="off"
				autocomplete="off"
				spellcheck="false"
				class="mt-3 h-[52px] w-full rounded border-2 border-slate-400 bg-white/75 px-3 text-center font-mono text-base outline-none focus:border-moonstone-500 focus:bg-white focus:placeholder-transparent"
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
