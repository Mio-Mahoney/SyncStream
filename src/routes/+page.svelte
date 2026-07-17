<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		generateRoomCode,
		isValidRoomCode,
		normalizeRoomCode,
		CODE_LENGTH
	} from '$lib/rendezvous/codes';

	let roomCode = $state('');
	let error = $state('');

	const canJoin = $derived(isValidRoomCode(roomCode));

	function join() {
		if (!canJoin) {
			error = `Room codes are ${CODE_LENGTH} characters.`;
			return;
		}
		goto(resolve('/room/[id]', { id: roomCode }));
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
		goto(`${path}?create=1`);
	}

	function onInput() {
		roomCode = normalizeRoomCode(roomCode);
		error = '';
	}
</script>

<svelte:head>
	<title>SyncStream</title>
	<meta
		name="description"
		content="Watch a local video together, in sync, with no upload and no server."
	/>
</svelte:head>

<main class="w-screen h-screen font-sans flex flex-col items-center justify-center px-6">
	<h1 class="text-5xl mb-4 text-center">SyncStream</h1>
	<p class="mb-16 text-center text-moonstone-800 max-w-md">
		Play a video off your own disk and watch it together, in sync. Nothing uploads anywhere.
	</p>

	<div class="grid grid-cols-2 gap-5 w-fit">
		<input
			bind:value={roomCode}
			oninput={onInput}
			onkeydown={(e) => e.key === 'Enter' && join()}
			placeholder="Enter a code"
			aria-label="Room code"
			autocapitalize="characters"
			autocomplete="off"
			spellcheck="false"
			class="bg-white/75 focus:placeholder-transparent outline-none focus:border-slate-500 focus:bg-white border-slate-400 border-2 col-span-2 h-[70px] text-[40px] text-center tracking-[0.2em] font-mono"
		/>
		<button
			onclick={join}
			disabled={!canJoin}
			class="border px-4 text-xl rounded bg-moonstone-100 hover:bg-moonstone-200 transition active:bg-moonstone-300 p-2 disabled:opacity-40 disabled:hover:bg-moonstone-100"
			>Join</button
		>
		<button
			class="border rounded px-4 text-xl bg-tangerine-400 hover:bg-tangerine-500 transition active:bg-tangerine-600 p-2"
			onclick={createRoom}>Create room</button
		>
	</div>

	{#if error}
		<p class="mt-6 text-tangerine-800" role="alert">{error}</p>
	{/if}
</main>
