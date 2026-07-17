<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import DebugOverlay from '$lib/DebugOverlay.svelte';
	import { tierMessage } from '$lib/media/probe';
	import { isDebug, exposeTestOracle, stats } from '$lib/stats.svelte';
	import { startHostRoom, type HostRoom } from '$lib/room/host';
	import { startGuestRoom, type GuestRoom } from '$lib/room/guest';
	import { strategyFromParams } from '$lib/rendezvous/room';
	import { isValidRoomCode } from '$lib/rendezvous/codes';

	let video: HTMLVideoElement;

	const code = $derived(page.params.id ?? '');
	// The share link never carries `create`, so a guest opening it can never
	// race the host for the same code.
	const isHost = $derived(page.url.searchParams.get('create') === '1');

	/**
	 * What the host actually announced. Normally the URL's code, but an
	 * occupancy collision (PLAN.md 4.7) draws a fresh one, and then this is the
	 * truth and the URL is stale. Showing the URL's code there would invite
	 * people into a room that does not exist.
	 */
	let hostedCode = $state<string | null>(null);
	const shownCode = $derived(hostedCode ?? code);

	/**
	 * The room is announced and `host` exists. The file picker is gated on this
	 * because the code renders from the URL the moment the page does, well
	 * before rendezvous confirms: without the gate, a file chosen in that window
	 * lands on a null host and is silently dropped.
	 */
	let opened = $state(false);

	let status = $state('Connecting...');
	let error = $state('');
	let unplayable = $state('');
	let shareUrl = $state('');
	let waitingOn = $state<string[]>([]);
	let guests = $state<{ peerId: string; name: string }[]>([]);
	let ready = $state(false);
	let copied = $state(false);
	let barrierEnabled = $state(true);
	let debug = $state(false);

	let host: HostRoom | null = null;
	let guest: GuestRoom | null = null;

	let playing = $state(false);
	let duration = $state(0);
	let currentTime = $state(0);

	const name = `Guest ${Math.floor(Math.random() * 900 + 100)}`;

	onMount(() => {
		debug = isDebug();
		exposeTestOracle();

		if (!isValidRoomCode(code)) {
			error = 'That is not a valid room code.';
			status = '';
			return;
		}

		const ac = new AbortController();
		(isHost ? asHost(ac.signal) : asGuest(ac.signal)).catch((e: Error) => {
			error = e.message;
			status = '';
		});

		return () => {
			ac.abort();
			host?.close();
			guest?.close();
		};
	});

	async function asHost(signal: AbortSignal) {
		status = 'Opening the room...';
		host = await startHostRoom({
			video,
			name: 'Host',
			origin: page.url.origin,
			code,
			signal,
			onSource: ({ objectUrl }) => {
				// A directly-playable file plays off disk; a transcoded one is
				// pulled through our own origin like any guest would.
				if (objectUrl) video.src = objectUrl;
				ready = true;
				status = '';
			},
			onError: (e) => (error = e.message),
			onGuests: (g) => (guests = g),
			onWaiting: (on) => {
				waitingOn = on;
				stats.waitingOn = on;
			}
		});
		hostedCode = host.code;
		shareUrl = host.shareUrl;
		opened = true;
		if (host.code !== code) {
			// A collision was resolved by regenerating. Keep the address bar
			// honest so a reload re-hosts the room that actually exists.
			const path = resolve('/room/[id]', { id: host.code });
			// The path IS resolved. The rule only recognises a bare resolve() call
			// and cannot see through appending a query string to one.
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			replaceState(`${path}?create=1`, {});
		}
		status = 'Pick a video to start.';
	}

	async function asGuest(signal: AbortSignal) {
		status = 'Looking for the host...';
		guest = await startGuestRoom({
			video,
			code,
			name,
			preferred: strategyFromParams(page.url.searchParams),
			signal,
			onReady: (d) => {
				duration = d;
				ready = true;
				status = '';
			},
			onUnplayable: (reason) => (unplayable = reason),
			onWaiting: (on) => {
				waitingOn = on;
				stats.waitingOn = on;
			},
			onError: (e) => (error = e.message),
			onHostGone: () => {
				// PLAN.md Phase 1: the room exists while the host is connected.
				status = 'The host left, so the room is over.';
				ready = false;
			}
		});
	}

	async function onFile(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file || !host) return;
		status = 'Reading the file...';
		unplayable = '';
		try {
			const probe = await host.setFile(file);
			status = probe.tier === 'direct' ? '' : tierMessage(probe, true);
		} catch (err) {
			unplayable = (err as Error).message;
			status = '';
		}
	}

	// Guests send intent; the host decides and broadcasts (PLAN.md 4.9).
	function togglePlay() {
		const action = playing ? 'pause' : 'play';
		if (host) host.state.applyIntent({ t: 'intent', action, mediaTime: video.currentTime });
		else guest?.sendIntent(action, video.currentTime);
	}

	function seek(e: Event) {
		const t = Number((e.target as HTMLInputElement).value);
		if (host) host.state.applyIntent({ t: 'intent', action: 'seek', mediaTime: t });
		else guest?.sendIntent('seek', t);
	}

	function onTimeUpdate() {
		currentTime = video.currentTime;
		duration = Number.isFinite(video.duration) ? video.duration : duration;
		syncPlayState();
	}

	/**
	 * timeupdate only fires while the media is advancing, so reading play state
	 * solely from it leaves the overlay (and the test oracle) asserting
	 * "playing" forever after a pause. Every transition has to write it.
	 */
	function syncPlayState() {
		playing = !video.paused;
		stats.mediaTime = video.currentTime;
		stats.playing = playing;
	}

	async function copyLink() {
		await navigator.clipboard.writeText(shareUrl);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}

	function toggleBarrier() {
		barrierEnabled = !barrierEnabled;
		host?.barrier.setEnabled(barrierEnabled);
	}
</script>

<svelte:head>
	<title>Room {shownCode} - SyncStream</title>
</svelte:head>

{#if debug}
	<DebugOverlay />
{/if}

<main class="flex min-h-screen flex-col items-center px-4 py-6 font-sans">
	<header class="mb-4 flex w-full max-w-5xl items-center justify-between gap-4">
		<div>
			<span class="text-sm text-moonstone-800">Room</span>
			<b class="ml-2 font-mono text-2xl tracking-[0.2em]" data-testid="room-code">{shownCode}</b>
		</div>
		{#if shareUrl}
			<button
				onclick={copyLink}
				class="rounded border bg-moonstone-100 px-3 py-1 text-sm transition hover:bg-moonstone-200"
				data-testid="copy-link">{copied ? 'Copied' : 'Copy invite link'}</button
			>
		{/if}
	</header>

	{#if error}
		<p
			class="mb-4 max-w-2xl rounded bg-tangerine-100 px-4 py-3 text-tangerine-900"
			role="alert"
			data-testid="error"
		>
			{error}
		</p>
	{/if}

	{#if unplayable}
		<p
			class="mb-4 max-w-2xl rounded bg-tangerine-100 px-4 py-3 text-tangerine-900"
			role="alert"
			data-testid="unplayable"
		>
			{unplayable}
		</p>
	{/if}

	{#if status}
		<p class="mb-4 text-moonstone-800" data-testid="status">{status}</p>
	{/if}

	{#if isHost && opened && !ready && !unplayable}
		<label
			class="mb-4 cursor-pointer rounded border-2 border-dashed border-moonstone-400 px-8 py-10 text-center"
		>
			<input
				type="file"
				accept="video/*"
				class="sr-only"
				onchange={onFile}
				data-testid="file-input"
			/>
			<span class="text-lg">Choose a video</span>
			<span class="mt-1 block text-sm text-moonstone-800">It never leaves your machine.</span>
		</label>
	{/if}

	<div class="w-full max-w-5xl" class:hidden={!ready}>
		<video
			bind:this={video}
			ontimeupdate={onTimeUpdate}
			onplay={syncPlayState}
			onpause={syncPlayState}
			onended={syncPlayState}
			class="w-full bg-black"
			data-testid="video"
			playsinline
		></video>

		<div class="mt-2 flex items-center gap-3">
			<button
				onclick={togglePlay}
				class="rounded bg-tangerine-400 px-4 py-2 transition hover:bg-tangerine-500"
				data-testid="play">{playing ? 'Pause' : 'Play'}</button
			>
			<input
				type="range"
				min="0"
				max={duration || 0}
				step="0.1"
				value={currentTime}
				onchange={seek}
				class="flex-1"
				aria-label="Seek"
				data-testid="seek"
			/>
			<span class="font-mono text-sm tabular-nums">
				{currentTime.toFixed(0)} / {duration.toFixed(0)}s
			</span>
			<button
				onclick={() => video.requestFullscreen()}
				class="rounded bg-[#B2BEB5] px-3 py-2 text-sm">Fullscreen</button
			>
		</div>

		{#if waitingOn.length}
			<p class="mt-3 rounded bg-vanilla-500 px-4 py-2" data-testid="waiting">
				Waiting for {waitingOn.join(', ')}
			</p>
		{/if}

		{#if isHost}
			<div class="mt-3 flex items-center justify-between text-sm text-moonstone-800">
				<span data-testid="guests">
					{guests.length === 0 ? 'No guests yet' : `${guests.length} watching`}
				</span>
				<label class="flex cursor-pointer items-center gap-2">
					<input type="checkbox" checked={barrierEnabled} onchange={toggleBarrier} />
					Pause when someone falls behind
				</label>
			</div>
		{/if}
	</div>
</main>
