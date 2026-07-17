<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import DebugOverlay from '$lib/DebugOverlay.svelte';
	import FilePicker from '$lib/FilePicker.svelte';
	import PlayerControls from '$lib/PlayerControls.svelte';
	import WaitingRoom, { type Phase } from '$lib/WaitingRoom.svelte';
	import { tierMessage } from '$lib/media/probe';
	import { isDebug, exposeTestOracle, stats } from '$lib/stats.svelte';
	import { startHostRoom, type HostRoom } from '$lib/room/host';
	import { startGuestRoom, type GuestRoom } from '$lib/room/guest';
	import { RendezvousError, strategyFromParams } from '$lib/rendezvous/room';
	import { isValidRoomCode } from '$lib/rendezvous/codes';

	// Reactive because the control bar takes it as a prop: bind:this only assigns
	// after the first render, so a plain `let` would hand the bar a permanent
	// undefined. Asserted non-null as everything that reads it runs after mount.
	let video = $state<HTMLVideoElement>()!;
	/** Fullscreened in place of the video, so the controls come along with it. */
	let player = $state<HTMLElement>();

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
	/** Set once the host says hello. Empty means we are still searching. */
	let hostName = $state('');
	/** A guest's join that walked the whole ladder and found no host. */
	let joinFailure = $state<RendezvousError | null>(null);
	/** The URL's code could not name a room, so nothing was ever attempted. */
	let badCode = $state(false);
	let roomOver = $state(false);
	/** A file is being probed. Picking a second one now would race the first. */
	let reading = $state(false);
	let barrierEnabled = $state(true);
	let debug = $state(false);

	let host: HostRoom | null = null;
	let guest: GuestRoom | null = null;

	let playing = $state(false);
	let duration = $state(0);
	let currentTime = $state(0);

	const name = `Guest ${Math.floor(Math.random() * 900 + 100)}`;

	/**
	 * Which wait a guest is in, or null when there is nothing to wait for. A
	 * guest has no picker and no controls until the host sends a video, so
	 * without this the whole page is one line of grey text.
	 */
	function phaseFor(): Phase | null {
		// Ahead of the host check: a code that cannot name a room leaves nothing
		// to host either, and whoever is holding the broken link needs the same
		// way out regardless of which end of it they thought they were on.
		if (badCode) return 'invalid';
		// The host's own waits are the picker's to describe, and a hard error
		// already has a banner that says more than a phase name could.
		if (isHost || error) return null;
		if (joinFailure) return 'failed';
		// Outranks `ready`, since the host can also leave mid-film.
		if (roomOver) return 'ended';
		if (ready) return null;
		return hostName ? 'found' : 'searching';
	}
	const guestPhase = $derived(phaseFor());

	onMount(() => {
		debug = isDebug();
		exposeTestOracle();

		if (!isValidRoomCode(code)) {
			// Not routed through `error`: that banner is for something that went
			// wrong mid-session, and it leaves the page with no controls on it at
			// all. A broken link is a dead end like any other, and belongs on the
			// screen that knows how to end one.
			badCode = true;
			status = '';
			return;
		}

		const ac = new AbortController();
		(isHost ? asHost(ac.signal) : asGuest(ac.signal)).catch((e: Error) => {
			status = '';
			// "room X was not reachable on any strategy tried (nostr: no host
			// answered within 9813ms; ...)" is a true sentence that tells a guest
			// nothing they can act on. The waiting room says what it means and
			// offers a way out; the relay log survives behind a disclosure.
			if (!isHost && e instanceof RendezvousError) joinFailure = e;
			else error = e.message;
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
		// The waiting room speaks for the guest now; a second line of status text
		// underneath it would only ever repeat or contradict it.
		status = '';
		guest = await startGuestRoom({
			video,
			code,
			name,
			preferred: strategyFromParams(page.url.searchParams),
			signal,
			onReady: (d) => {
				duration = d;
				ready = true;
			},
			onHostFound: (n) => (hostName = n),
			onUnplayable: (reason) => (unplayable = reason),
			onWaiting: (on) => {
				waitingOn = on;
				stats.waitingOn = on;
			},
			onError: (e) => (error = e.message),
			onHostGone: () => {
				// PLAN.md Phase 1: the room exists while the host is connected.
				roomOver = true;
				ready = false;
			}
		});
	}

	async function onFile(file: File) {
		if (!host) return;
		reading = true;
		status = 'Reading the file...';
		unplayable = '';
		try {
			const probe = await host.setFile(file);
			status = probe.tier === 'direct' ? '' : tierMessage(probe, true);
		} catch (err) {
			unplayable = (err as Error).message;
			status = '';
		} finally {
			reading = false;
		}
	}

	// Guests send intent; the host decides and broadcasts (PLAN.md 4.9).
	function togglePlay() {
		const action = playing ? 'pause' : 'play';
		if (host) host.state.applyIntent({ t: 'intent', action, mediaTime: video.currentTime });
		else guest?.sendIntent(action, video.currentTime);
	}

	function seek(t: number) {
		if (host) host.state.applyIntent({ t: 'intent', action: 'seek', mediaTime: t });
		else guest?.sendIntent('seek', t);
	}

	function onTimeUpdate() {
		currentTime = video.currentTime;
		syncDuration();
		syncPlayState();
	}

	/**
	 * A guest is told the duration up front, but the host only ever had it from
	 * timeupdate, which does not fire until playback starts. That left the host
	 * staring at a 0:00 total and a seek bar pinned to max=0 - unable to scrub to
	 * a starting point without first playing from the top.
	 */
	function syncDuration() {
		if (Number.isFinite(video.duration) && video.duration > 0) duration = video.duration;
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

	/**
	 * A reload rather than re-running `asGuest`: the failed join left a
	 * half-built network behind it, and starting clean is both simpler and more
	 * likely to work than reusing it. Safe here in a way it is not for a host,
	 * whose reload ends the room.
	 */
	function retryJoin() {
		location.reload();
	}

	function toggleBarrier() {
		barrierEnabled = !barrierEnabled;
		host?.barrier.setEnabled(barrierEnabled);
	}
</script>

<svelte:head>
	<title>{badCode ? 'Not a room' : `Room ${shownCode}`} - SyncStream</title>
</svelte:head>

{#if debug}
	<DebugOverlay />
{/if}

<main class="flex min-h-screen flex-col items-center px-4 py-6 font-sans">
	<!--
		Withheld when the code is broken. The header announced "Room
		badcode-nonsense" in the same 2xl mono as a real code, directly above a
		banner saying that is not a room code - dressing the URL's garbage up as a
		room and then denying it.
	-->
	{#if !badCode}
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
	{/if}

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

	<!--
		Deliberately still mounted once `unplayable` is set. A rejected file used
		to take the picker down with it, so the host who dropped an .mkv read a
		message telling them to remux it and had nothing left to drop the remux
		onto short of reloading the page, which ends the room.
	-->
	{#if isHost && opened && !ready}
		<FilePicker {onFile} onReject={(reason) => (unplayable = reason)} busy={reading} />
	{/if}

	{#if guestPhase}
		<WaitingRoom
			phase={guestPhase}
			code={shownCode}
			{hostName}
			attempts={joinFailure?.attempts ?? []}
			onRetry={retryJoin}
		/>
	{/if}

	<div class="w-full max-w-5xl" class:hidden={!ready}>
		<div bind:this={player} class="player overflow-hidden rounded bg-black">
			<video
				bind:this={video}
				ontimeupdate={onTimeUpdate}
				onloadedmetadata={syncDuration}
				ondurationchange={syncDuration}
				onplay={syncPlayState}
				onpause={syncPlayState}
				onended={syncPlayState}
				class="w-full bg-black"
				data-testid="video"
				playsinline
			></video>

			<PlayerControls
				{video}
				container={player}
				{playing}
				{currentTime}
				{duration}
				onToggle={togglePlay}
				onSeek={seek}
			/>
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

<style>
	/**
	 * Fullscreen lands on the wrapper, not the video, so the controls come with
	 * it. That makes the video responsible for yielding the bar its height rather
	 * than running to the full viewport and pushing it off-screen.
	 */
	.player:fullscreen {
		display: flex;
		flex-direction: column;
		justify-content: center;
	}

	.player:fullscreen video {
		min-height: 0;
		flex: 1;
		object-fit: contain;
	}
</style>
