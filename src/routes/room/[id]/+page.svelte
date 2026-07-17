<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import BarrierNotice from '$lib/BarrierNotice.svelte';
	import DebugOverlay from '$lib/DebugOverlay.svelte';
	import FilePicker from '$lib/FilePicker.svelte';
	import HostBar from '$lib/HostBar.svelte';
	import InvitePanel from '$lib/InvitePanel.svelte';
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
	/** Guests holding the room up, never including whoever is reading this page. */
	let waitingOn = $state<string[]>([]);
	/** This page's reader is one of them. Only ever true for a guest. */
	let waitingOnYou = $state(false);
	let guests = $state<{ peerId: string; name: string }[]>([]);
	let ready = $state(false);
	/** Set once the host says hello. Empty means we are still searching. */
	let hostName = $state('');
	/**
	 * Rendezvous walked the whole ladder and came back with nothing. One state
	 * for both roles, because it is one failure: the guest found no room to join
	 * and the host opened none. Only the sentence differs.
	 */
	let rendezvousFailure = $state<RendezvousError | null>(null);
	/** The URL's code could not name a room, so nothing was ever attempted. */
	let badCode = $state(false);
	/**
	 * The host's announce never landed, so `shownCode` names nothing. Kept apart
	 * from the guest's read of the same failure: a guest's code was handed to
	 * them and is worth re-checking, but this one we drew ourselves.
	 */
	const roomUnopened = $derived(isHost && rendezvousFailure !== null);
	/**
	 * The code on screen names a room that exists and will keep existing under
	 * that code. The header renders it at 2xl mono under a "Room" label, which is
	 * an invitation to pass it on, so anything short of that is a trap:
	 *
	 * - `invalid` never named a room, `unopened` never got one.
	 * - A host's code before `opened` is a guess. We draw it with no server to
	 *   ask, and the only collision check available is to announce it and see
	 *   whether a rival host answers (PLAN.md 4.7) - so for the ~3s that takes,
	 *   the header was showing a code that could be, and on a collision demonstrably
	 *   IS, someone else's live room. It was then swapped out silently.
	 *
	 * A guest's code needs no such gate: it was handed to them, it is the room
	 * they are looking for either way, and nothing here can change it.
	 */
	const codeNamesARoom = $derived(!badCode && !roomUnopened && (!isHost || opened));

	let roomOver = $state(false);
	/** A file is being probed. Picking a second one now would race the first. */
	let reading = $state(false);
	/**
	 * The host asked for the picker back over a film that is already playing.
	 * Opt-in rather than always-on: the picker owns window-wide drag-and-drop, and
	 * a file dropped on a room mid-film is far more likely to be a misaimed drag
	 * than a decision to replace what everyone is watching.
	 */
	let changing = $state(false);
	let barrierEnabled = $state(true);
	let debug = $state(false);

	let host: HostRoom | null = null;
	let guest: GuestRoom | null = null;

	let playing = $state(false);
	let duration = $state(0);
	let currentTime = $state(0);
	/**
	 * The film has played for whoever is reading this page, at some point.
	 *
	 * Only the readiness barrier's copy needs it, and it needs it badly: the
	 * barrier holds the room both when a guest runs out of buffer mid-film and
	 * when a guest simply has not loaded the opening yet, and only the first of
	 * those is anybody falling behind. Latched rather than derived from
	 * `playing`, because the barrier's whole job is to pause - by the time the
	 * banner is up, `playing` is false in both cases and cannot tell them apart.
	 *
	 * Per reader, not per room, which is what makes it right for a guest who
	 * joins mid-film: the room has been playing for an hour, but nothing has
	 * fallen behind for THEM - they are loading their way in like everyone did.
	 */
	let started = $state(false);

	const name = `Guest ${Math.floor(Math.random() * 900 + 100)}`;

	/**
	 * Which wait this page is in, or null when there is nothing to wait for.
	 * Mostly a guest's, who has no picker and no controls until the host sends a
	 * video - without this the whole page is one line of grey text for them - but
	 * the role-independent dead ends land here too, and so does the one the host
	 * can reach before a room exists.
	 */
	function phaseFor(): Phase | null {
		// Ahead of the host check: a code that cannot name a room leaves nothing
		// to host either, and whoever is holding the broken link needs the same
		// way out regardless of which end of it they thought they were on.
		if (badCode) return 'invalid';
		// Also ahead of the host check. A failed announce left them the raw relay
		// log under a header naming the room it had just failed to open, with no
		// control on the page at all.
		if (roomUnopened) return 'unopened';
		// A hard error already has a banner that says more than a phase name could.
		if (error) return null;
		// The host's wait, and the counterpart of the guest's `searching` above it:
		// both are rendezvous taking its time, and both are a blank page until it
		// answers. The host's was one line of grey text with no spinner - the one
		// thing that tells "working on it" apart from "hung" - under a room code
		// that was not theirs to show yet. Their remaining waits are the invite
		// panel's and the picker's to describe, and those are real controls.
		if (isHost) return opened ? null : 'opening';
		if (rendezvousFailure) return 'failed';
		// Outranks `ready`, since the host can also leave mid-film.
		if (roomOver) return 'ended';
		if (ready) return null;
		// Below `ready` on purpose. A superseding file clears this anyway, but a
		// rejection that outranked a playing video is exactly the bug this fixes,
		// and the ordering makes it unreachable rather than merely unlikely.
		if (unplayable) return 'rejected';
		return hostName ? 'found' : 'searching';
	}
	const roomPhase = $derived(phaseFor());

	/**
	 * A tab title is a room code's other public face - it is what a host reads
	 * back to a friend over the phone - so it is gated on the same fact the
	 * header is, and says what is happening instead whenever the code cannot.
	 */
	const title = $derived(
		badCode
			? 'Not a room'
			: roomUnopened
				? "Couldn't open the room"
				: codeNamesARoom
					? `Room ${shownCode}`
					: 'Opening your room'
	);

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
			// answered within 9813ms; ...)" is a true sentence that tells nobody
			// anything they can act on. The waiting room says what it means and
			// offers a way out; the relay log survives behind a disclosure.
			//
			// Not gated on `!isHost` any more. That gate sent a host whose relays
			// were down to the error banner - the exact raw diagnostic, minus even
			// the guest's way out, under a header announcing the room it had just
			// failed to open. Rendezvous failing is not role-specific; only the
			// sentence it deserves is.
			if (e instanceof RendezvousError) rendezvousFailure = e;
			else error = e.message;
		});

		return () => {
			ac.abort();
			host?.close();
			guest?.close();
		};
	});

	async function asHost(signal: AbortSignal) {
		// The waiting room's `opening` phase speaks for this wait now, spinner and
		// all; a line of grey text underneath it would only repeat it.
		status = '';
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
				changing = false;
				// A film that has just been put on has not played for anyone yet, so
				// the barrier's opening buffer is nobody falling behind - the same
				// distinction the first film gets, which a latch would lose on the
				// second.
				started = false;
				status = '';
			},
			onError: (e) => (error = e.message),
			onGuests: (g) => (guests = g),
			// A host is never one of the guests the barrier waits on.
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
		// No "Pick a video to start." here. The invite panel and the picker below
		// it say what to do and are the controls for doing it; a line of grey text
		// repeating one of them only buries the other.
		status = '';
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
				// A second file supersedes the first, and the host's rejection of the
				// first stops being true the moment this arrives. Nothing used to
				// clear it, so a guest whose host retried watched the whole film under
				// a red banner swearing the video could not be played.
				unplayable = '';
				ready = true;
				// See the host's onSource: on a second film this is a reader who has
				// watched nothing of it, whatever they watched of the first.
				started = false;
			},
			onHostFound: (n) => (hostName = n),
			onUnplayable: (reason) => (unplayable = reason),
			onWaiting: (on, you) => {
				waitingOn = on;
				waitingOnYou = you;
				// The oracle answers "who is the room waiting on", so our own name
				// belongs in it - the UI's "you" is the same fact worded for a reader
				// who was never told which Guest NNN they are.
				stats.waitingOn = you ? [...on, name] : on;
			},
			onError: (e) => (error = e.message),
			// The film is already stopped by the time this runs: `ready` takes the
			// player off screen, and only off screen - `hidden` is display:none,
			// which does not stop a <video> - so stopping it is guest.ts's job,
			// next to the sync loop that would otherwise start it again.
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
		if (playing) started = true;
		stats.mediaTime = video.currentTime;
		stats.playing = playing;
	}

	/**
	 * A reload rather than re-running `asGuest`/`asHost`: the failed attempt left
	 * a half-built network behind it, and starting clean is both simpler and more
	 * likely to work than reusing it.
	 *
	 * A reload normally ends a host's room, which is why nothing else on their
	 * side offers one. It is safe on this path for the reason the path exists:
	 * the announce failed, so there is no room to end - and the URL still carries
	 * the code and `create=1`, so the reload re-hosts rather than joining.
	 */
	function retryRendezvous() {
		location.reload();
	}

	/**
	 * Opening and closing the picker over a playing film.
	 *
	 * Clears the rejection on the way out: it lives inside the picker now, and a
	 * host who read "that is not a video file" and chose to keep the film they had
	 * has finished with it. Leaving it set would hang it back up, unprompted and
	 * about a file two decisions ago, the next time they opened the picker.
	 */
	function toggleChanging() {
		changing = !changing;
		if (!changing) unplayable = '';
	}

	function toggleBarrier() {
		barrierEnabled = !barrierEnabled;
		host?.barrier.setEnabled(barrierEnabled);
	}

	/**
	 * Fullscreen outlives the film. `ready` going false takes the player off
	 * screen with display:none, and that does NOT exit fullscreen - the browser
	 * stays in fullscreen mode with the fullscreen element rendering nothing. So
	 * a guest whose host walked out, having watched the way a film is meant to be
	 * watched, is left in a chromeless window showing a "watch party is over"
	 * card laid out for a normal one, with nothing on screen accounting for why
	 * the window will not come back.
	 *
	 * Pointedly not wired to the readiness barrier, which also stops the film:
	 * that clears itself in seconds and the film resumes, and dropping someone
	 * out of fullscreen for a stall would be worse than the stall. This runs only
	 * when the player is gone and there is nothing left to be fullscreen about.
	 */
	$effect(() => {
		if (ready || !player) return;
		const fs = document.fullscreenElement;
		if (!fs || !player.contains(fs)) return;
		// Rejects if the browser left fullscreen by some other route first, which
		// is the state we wanted anyway.
		void document.exitFullscreen().catch(() => {});
	});
</script>

<svelte:head>
	<title>{title} - SyncStream</title>
</svelte:head>

{#if debug}
	<DebugOverlay />
{/if}

<main class="flex min-h-screen flex-col items-center px-4 py-6 font-sans">
	<!--
		Withheld until the code names a room. The header announced "Room
		badcode-nonsense" in the same 2xl mono as a real code, directly above a
		banner saying that is not a room code - dressing the URL's garbage up as a
		room and then denying it. A failed announce read even worse, because that
		code looks entirely real: it invites a host to send "Room VUF48U" to their
		friends, and nobody is listening on it. A host's code mid-announce is worse
		still: it looks real because it nearly always becomes real, which is exactly
		what makes the collision case - where it is a stranger's room - passable.
	-->
	{#if codeNamesARoom}
		<!--
			Just the code. The invite now lives wherever the host's attention already
			is - the panel before the film, the bar under the player during it -
			rather than in a corner button that had to be found, and that could only
			ever be copied blind.
		-->
		<header class="mb-4 flex w-full max-w-5xl items-center gap-4">
			<div>
				<span class="text-sm text-moonstone-800">Room</span>
				<b class="ml-2 font-mono text-2xl tracking-[0.2em]" data-testid="room-code">{shownCode}</b>
			</div>
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

	{#if status}
		<p class="mb-4 text-moonstone-800" data-testid="status">{status}</p>
	{/if}

	<!--
		Deliberately still mounted once `unplayable` is set. A rejected file used
		to take the picker down with it, so the host who dropped an .mkv read a
		message telling them to remux it and had nothing left to drop the remux
		onto short of reloading the page, which ends the room.

		The rejection itself rides inside the picker rather than in a banner up
		here. It is written for whoever holds the file, and the picker is the only
		place they can act on it - see FilePicker's `rejected`. A guest's side of
		the same fact goes to the waiting room, which words it for someone who is
		not sitting at the machine that cannot decode the thing.
	-->
	{#if isHost && opened && !ready}
		<!--
			Above the picker, because this is the half of the wait that pays off
			later: guests take time to arrive, and sending the link first means they
			are connecting while the host is still finding a file. The host already
			knew who had joined - `guests` has been populated since the first hello -
			but the only thing rendering it lived inside the player block, hidden
			until playback, so the whole pre-film wait reported nothing.
		-->
		<InvitePanel {shareUrl} {guests} />
		<FilePicker
			{onFile}
			onReject={(reason) => (unplayable = reason)}
			busy={reading}
			rejected={unplayable}
		/>
	{/if}

	{#if roomPhase}
		<WaitingRoom
			phase={roomPhase}
			code={shownCode}
			{hostName}
			attempts={rendezvousFailure?.attempts ?? []}
			reason={unplayable}
			onRetry={retryRendezvous}
		/>
	{/if}

	<div class="w-full max-w-5xl" class:hidden={!ready}>
		<div bind:this={player} class="player relative overflow-hidden rounded bg-black">
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

			<!--
				Inside the player, not below it. This is the fullscreen element, and a
				sibling of it is not painted while fullscreen is up - so the one account
				anybody gets of a film that froze on its own was withheld from whoever
				was watching the way a film is meant to be watched: full screen, staring
				at a picture that had just stopped, with nothing on it saying why.

				`waitingOnYou` is its own condition, not folded into the list: the guest
				the room is waiting for is excluded from `on` precisely so the banner can
				address them, which means their own stall shows up here as an empty list.
			-->
			{#if waitingOn.length || waitingOnYou}
				<BarrierNotice on={waitingOn} you={waitingOnYou} {started} />
			{/if}
		</div>

		<!--
			The invite panel's two facts do not stop mattering once the film starts:
			who is here, and how to let one more person in. Both used to get worse at
			exactly that moment - names collapsed to a "1 watching" count, and the
			only way to invite became a corner button with no link on screen behind
			it.
		-->
		<!--
			On `ready`, not on the enclosing block's `hidden`: that block stays
			mounted so the <video> survives, which would otherwise leave this bar's
			invite button in the DOM alongside the panel's - two invite affordances,
			one of them invisible.
		-->
		{#if isHost && ready}
			<HostBar
				{shareUrl}
				{guests}
				{barrierEnabled}
				onToggleBarrier={toggleBarrier}
				{changing}
				onToggleChanging={toggleChanging}
			/>
		{/if}
	</div>

	<!--
		Below the player rather than in place of it, so the film everyone is still
		watching keeps playing while the host looks for its replacement - and so
		backing out of the picker costs nothing. `onSource` closes it once the new
		file is accepted; a rejected one leaves it open, which is the whole point of
		the picker surviving a rejection.
	-->
	{#if isHost && ready && changing}
		<div class="mt-6 flex w-full flex-col items-center">
			<FilePicker
				{onFile}
				onReject={(reason) => (unplayable = reason)}
				busy={reading}
				rejected={unplayable}
			/>
		</div>
	{/if}
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
