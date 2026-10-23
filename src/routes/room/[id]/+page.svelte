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
	import NameTag from '$lib/NameTag.svelte';
	import NowPlaying from '$lib/NowPlaying.svelte';
	import PausedNotice from '$lib/PausedNotice.svelte';
	import Presence from '$lib/Presence.svelte';
	import WaitingRoom from '$lib/WaitingRoom.svelte';
	import { roomPhase } from '$lib/room/phase';
	import FaultNotice from '$lib/FaultNotice.svelte';
	import { fallbackName, readName, saveName } from '$lib/identity';
	import { tierMessage } from '$lib/media/probe';
	import { FaultError, faultOf, type Fault } from '$lib/protocol/control';
	import { isDebug, exposeTestOracle, stats } from '$lib/stats.svelte';
	import { startHostRoom, type HostRoom } from '$lib/room/host';
	import { startGuestRoom, type GuestRoom } from '$lib/room/guest';
	import {
		RendezvousError,
		STRATEGY_PARAM,
		UnreachableError,
		strategyFromParams
	} from '$lib/rendezvous/room';
	import {
		generateRoomSecret,
		isValidRoomCode,
		roomHash,
		secretFromHash
	} from '$lib/rendezvous/codes';

	// Reactive because the control bar takes it as a prop: bind:this only assigns
	// after the first render, so a plain `let` would hand the bar a permanent
	// undefined. Asserted non-null as everything that reads it runs after mount.
	let video = $state<HTMLVideoElement>()!;
	/** Fullscreened in place of the video, so the controls come along with it. */
	let player = $state<HTMLElement>();
	/** The picker that opens under a playing film. Below the fold where it mounts. */
	let changePicker = $state<HTMLElement>();

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

	let error = $state('');
	/** The last file this host offered that will not play, or null. */
	let unplayable = $state<Fault | null>(null);
	/**
	 * A second film the host tried to put on and could not, while the first
	 * stays on. Both roles hold it: the host's picker shows the fault itself,
	 * and this is the note beside the film for everyone that the switch did
	 * not happen - which, for a guest, is the only account they get.
	 */
	let switchFailed = $state<{ title: string; fault: Fault } | null>(null);
	/**
	 * Guests whose browser refused the film, by peer, with what it said. Host
	 * only: a guest's own refusal is in `error` on their screen. Each entry is
	 * why one friend is not watching, and the barrier has already let go of them.
	 */
	let cannotPlay = $state<{ peerId: string; name: string; fault: Fault }[]>([]);
	/**
	 * Rendezvous found people in the room and none of them is the host, for
	 * long enough to say so. Cleared the moment a host says hello.
	 */
	let hostless = $state(false);
	/**
	 * The film playing right now is not being played off disk - it is being
	 * converted as it streams (PLAN.md 4.3's tier 2). Host-only, and true for as
	 * long as that film is on, which is why it rides under the player rather than
	 * in a line of page-top text: it explains a fan that will not stop spinning.
	 *
	 * Written after `setFile` resolves, so a rejected file leaves it alone - the
	 * rejection never displaced the film, and the note is about whatever is
	 * actually playing.
	 */
	let converting = $state('');
	/**
	 * What the room is watching, as the host names it. Both roles hold it and both
	 * render it under the player: the host learns it from `onSource` (it is their
	 * file), a guest is told on `ready` (see film.ts for why nobody could say).
	 *
	 * `film` and not `title`, which is this page's tab title - a different string
	 * for a different surface, and one of them is a room code.
	 */
	let film = $state('');
	let shareUrl = $state('');
	/** Guests holding the room up, never including whoever is reading this page. */
	let waitingOn = $state<string[]>([]);
	/** This page's reader is one of them. Only ever true for a guest. */
	let waitingOnYou = $state(false);
	/**
	 * Whoever stopped the film on purpose, as the host names them, or '' when
	 * nothing did. Anyone in the room can pause it for everyone, so this is the
	 * only thing that stops a film halting at the request of someone the reader
	 * cannot see, with no account of it anywhere.
	 *
	 * Empty for the person who pressed pause: the host says whether that is us
	 * (`pausedByYou`), rather than us matching a name we could share with someone.
	 */
	let pausedBy = $state('');
	/** The reader is who paused it, so they need no telling. */
	let pausedByYou = $state(false);
	let guests = $state<{ peerId: string; name: string }[]>([]);
	/**
	 * A guest's read of the same roster, as the host states it. Kept apart from
	 * `guests`, which is the host's own view and never contains a host.
	 *
	 * The host stays its own field rather than heading a flat list, because the
	 * two screens that read this want different halves: under the player it is one
	 * room, and in the waiting room the host is already named a line above.
	 */
	let company = $state<{ host: string; guests: string[] }>({ host: '', guests: [] });
	/** The room as a guest watching it reads it: the host, then everyone else. */
	const room = $derived([company.host, ...company.guests].filter(Boolean));
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
	 * A guest's link named a room and carried no key for it (codes.ts), so
	 * nothing was attempted: without the key no connection can form, and a
	 * search would have ended in `failed` with advice to check a code that is
	 * right. A host without one simply mints one - it is their room.
	 */
	let noKey = $state(false);
	/**
	 * The page is not a secure context, so nothing was attempted here either.
	 *
	 * Browsers hand out `crypto.subtle` (and WebCodecs) only on https and on
	 * localhost. The signaling layer hashes and encrypts every message with it,
	 * so on any other origin each one throws inside the rendezvous library and
	 * the room is never found: a guest read "No one is hosting" after thirty
	 * seconds, about a host sitting on the same network. The way to get here is
	 * the obvious one - serve the app from one computer and open its LAN address
	 * (http://192.168.x.x) on another.
	 */
	let insecure = $state(false);
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
	const codeNamesARoom = $derived(
		!badCode && !noKey && !insecure && !roomUnopened && (!isHost || opened)
	);

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

	/**
	 * What the room calls us. A remembered name if we have ever set one, and the
	 * machine's fallback otherwise - the room always opens, because the invite
	 * link's whole promise is that it opens straight away and a name prompt in
	 * front of it would be a toll booth (see identity.ts).
	 *
	 * Reactive, because it is on screen: the tag in the panel, the bar and the
	 * waiting room all read it back, and the whole point of the control is that
	 * the reader sees it take.
	 */
	let name = $state('');

	function rename(next: string) {
		name = next;
		saveName(next);
		// The engines announced us under the fallback the moment we connected, so
		// this is a correction sent to a room that has already met us - not a value
		// read at join time.
		host?.setName(next);
		guest?.setName(next);
	}

	/**
	 * Which wait this page is in, or null when there is nothing to wait for.
	 * Mostly a guest's, who has no picker and no controls until the host sends a
	 * video - without this the whole page is one line of grey text for them - but
	 * the role-independent dead ends land here too, and so does the one the host
	 * can reach before a room exists. The precedence lives in room/phase.ts.
	 */
	const phase = $derived(
		roomPhase({
			isHost,
			badCode,
			insecure,
			noKey,
			opened,
			error: error !== '',
			rendezvous:
				rendezvousFailure === null
					? 'pending'
					: rendezvousFailure instanceof UnreachableError
						? 'unreachable'
						: 'failed',
			roomOver,
			ready,
			rejected: unplayable !== null,
			hostFound: hostName !== '',
			hostless
		})
	);

	/**
	 * A tab title is a room code's other public face - it is what a host reads
	 * back to a friend over the phone - so it is gated on the same fact the
	 * header is, and says what is happening instead whenever the code cannot.
	 */
	const title = $derived(
		badCode
			? 'Not a room'
			: noKey
				? 'Link is missing its key'
				: insecure
					? 'Needs a secure address'
					: roomUnopened
						? "Couldn't open the room"
						: codeNamesARoom
							? `Room ${shownCode}`
							: 'Opening your room'
	);

	onMount(() => {
		debug = isDebug();
		exposeTestOracle();
		// In onMount rather than at the top level: localStorage does not exist
		// while this page is being prerendered.
		name = readName() || fallbackName(isHost ? 'host' : 'guest');

		if (!isValidRoomCode(code)) {
			// Not routed through `error`: that banner is for something that went
			// wrong mid-session, and it leaves the page with no controls on it at
			// all. A broken link is a dead end like any other, and belongs on the
			// screen that knows how to end one.
			badCode = true;
			return;
		}

		if (!window.isSecureContext) {
			insecure = true;
			return;
		}

		// The key rides the fragment (codes.ts), which SvelteKit's `page.url`
		// carries. A host without one has simply never had one minted - a
		// bookmark from before keys, or a hand-typed URL - and it is their room
		// to key: the address bar is corrected so a reload keeps the same key and
		// the invite link they copy carries it. A guest without one has a link
		// that was cut short, and nothing can be attempted for them.
		let secret = secretFromHash(page.url.hash);
		if (!secret) {
			if (!isHost) {
				noKey = true;
				return;
			}
			// Minted here; written into the address bar once the room is open
			// (see asHost), which is also when a collision's new code lands there.
			secret = generateRoomSecret();
		}

		const ac = new AbortController();
		(isHost ? asHost(ac.signal, secret) : asGuest(ac.signal, secret)).catch((e: Error) => {
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

	async function asHost(signal: AbortSignal, secret: string) {
		host = await startHostRoom({
			video,
			name,
			origin: page.url.origin,
			code,
			secret,
			// The same `?s=` a guest reads, honoured for the host too: it is how
			// the e2e suite pins a room to the localhost relay (PLAN.md 4.6's
			// escape hatch), and on the public strategies it merely reorders the
			// announce priority.
			strategy: strategyFromParams(page.url.searchParams),
			signal,
			onSource: ({ title }) => {
				// The engine has already pointed the element at it: off disk for a
				// directly-playable file, through our own origin for a converted one.
				film = title;
				ready = true;
				changing = false;
				// A film that has just been put on has not played for anyone yet, so
				// the barrier's opening buffer is nobody falling behind - the same
				// distinction the first film gets, which a latch would lose on the
				// second.
				started = false;
			},
			onError: (e) => (error = e.message),
			onSwitchFailed: (title, fault) => (switchFailed = { title, fault }),
			onCannotPlay: (guest, fault) => {
				const rest = cannotPlay.filter((c) => c.peerId !== guest.peerId);
				cannotPlay = fault ? [...rest, { ...guest, fault }] : rest;
			},
			onGuests: (g) => {
				guests = g;
				// A guest who left takes their note with them.
				cannotPlay = cannotPlay.filter((c) => g.some((x) => x.peerId === c.peerId));
			},
			// A host is never one of the guests the barrier waits on.
			onWaiting: (on) => {
				waitingOn = on;
				stats.waitingOn = on;
			},
			onPaused: (by, you) => {
				pausedBy = by ?? '';
				pausedByYou = you;
			}
		});
		hostedCode = host.code;
		shareUrl = host.shareUrl;
		opened = true;
		if (host.code !== code || secretFromHash(page.url.hash) !== secret) {
			// A collision was resolved by regenerating, or the key was minted
			// just now. Keep the address bar honest so a reload re-hosts the room
			// that actually exists, under the same key -- on the same strategy,
			// which the reload can only learn from the URL.
			const path = resolve('/room/[id]', { id: host.code });
			const strategy = strategyFromParams(page.url.searchParams);
			const query = strategy ? `?create=1&${STRATEGY_PARAM}=${strategy}` : '?create=1';
			// The path IS resolved. The rule only recognises a bare resolve() call
			// and cannot see through appending a query string to one.
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			replaceState(`${path}${query}${roomHash(secret)}`, {});
		}
	}

	async function asGuest(signal: AbortSignal, secret: string) {
		const nameOnEntry = name;
		guest = await startGuestRoom({
			video,
			code,
			secret,
			name: nameOnEntry,
			preferred: strategyFromParams(page.url.searchParams),
			signal,
			onReady: ({ duration: d, title }) => {
				duration = d;
				film = title;
				// A second file supersedes the first, and the host's rejection of the
				// first stops being true the moment this arrives. Nothing used to
				// clear it, so a guest whose host retried watched the whole film under
				// a red banner swearing the video could not be played.
				unplayable = null;
				// A film that did arrive retires the note about one that did not.
				switchFailed = null;
				ready = true;
				// See the host's onSource: on a second film this is a reader who has
				// watched nothing of it, whatever they watched of the first.
				started = false;
			},
			onHostName: (n) => {
				hostName = n;
				hostless = false;
				// A host saying hello is a room that exists, whatever happened to the
				// last one: a host who reloads comes back as a new page on the same
				// code, and every guest who stayed is still here to meet it.
				roomOver = false;
			},
			onNoHost: () => (hostless = true),
			onCompany: (r) => (company = r),
			onUnplayable: (fault) => (unplayable = fault),
			onSwitchFailed: (title, fault) => (switchFailed = { title, fault }),
			onWaiting: (on, you) => {
				waitingOn = on;
				waitingOnYou = you;
				// The oracle answers "who is the room waiting on", so our own name
				// belongs in it - the UI's "you" is the same fact worded for a reader
				// who was never told which Guest NNN they are.
				stats.waitingOn = you ? [...on, name] : on;
			},
			onPaused: (by, you) => {
				pausedBy = by ?? '';
				pausedByYou = you;
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
		// The waiting room offers the name control from its first frame, and this
		// engine did not exist for any of the seconds rendezvous spent walking the
		// relay ladder - which is precisely the wait the control is there to fill.
		// A rename in that window lands on a null `guest` and is silently dropped:
		// the tag reads the new name, the room has never heard it, and nothing on
		// screen ever says so. By now we have said hello under `nameOnEntry`, so
		// this is a correction, not a first announcement.
		//
		// The host needs no counterpart: its own name control lives in the invite
		// panel, which is gated on `opened` and so cannot exist before its engine.
		if (name !== nameOnEntry) guest.setName(name);
	}

	/**
	 * No "Reading the file..." line up here any more. The picker already says it,
	 * with the filename attached and at the box the file was just dropped on,
	 * while this said the same fact worse and 250px away - and, being a line that
	 * appears from nothing, shoved the panel and the picker 40px down the page at
	 * the exact moment the host committed to a file.
	 */
	async function onFile(file: File) {
		if (!host) return;
		reading = true;
		unplayable = null;
		switchFailed = null;
		try {
			const probe = await host.setFile(file);
			// Assigned either way: a second film that plays off disk has to retire
			// the first one's note, not inherit it.
			converting = probe.tier === 'direct' ? '' : tierMessage(probe, true);
			cannotPlay = [];
		} catch (err) {
			// The engine has already told the room; this is the host's own copy,
			// at the picker the file was dropped on. `onSwitchFailed` has set the
			// note beside the film when there was one to keep.
			unplayable = err instanceof FaultError ? err.fault : faultOf(err);
		} finally {
			reading = false;
		}
	}

	// Guests send intent; the host decides and broadcasts (PLAN.md 4.9).
	function togglePlay() {
		const action = playing ? 'pause' : 'play';
		// Through `host.intent` rather than straight into the sync engine: the room
		// has to be able to say who stopped it, and a host who reaches past the
		// funnel a guest's intent lands in is a pause with no author.
		if (host) host.intent(action, video.currentTime);
		else guest?.sendIntent(action, video.currentTime);
	}

	function seek(t: number) {
		if (host) host.intent('seek', t);
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
		if (!changing) unplayable = null;
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

	/**
	 * The picker opens under the film, and a film fills the window - so it mounts
	 * below the fold. Measured on a 1280x720 laptop viewport, its top landed at
	 * y=744: the host clicked the one control for changing the film, the button
	 * relabelled itself to "Keep this video", and nothing else on screen moved.
	 * The picker they had just asked for was never in view, so the click read as
	 * dead and the way off a wrong film stayed as hidden as before it existed.
	 *
	 * `block: 'nearest'` scrolls the least that brings it in, which keeps the film
	 * everyone is still watching on screen above it - the reason the picker opens
	 * below the player rather than in place of it. Smooth unless the reader asked
	 * for less motion: the film stays put and only the page moves, so the scroll
	 * is what shows the picker came from below rather than replacing something.
	 */
	$effect(() => {
		if (!changing || !changePicker) return;
		changePicker.scrollIntoView({
			block: 'nearest',
			behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
		});
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
		<InvitePanel {shareUrl} {guests} {name} onRename={rename} />
		<FilePicker
			{onFile}
			onReject={(fault) => (unplayable = fault)}
			busy={reading}
			rejected={unplayable}
		/>
	{/if}

	{#if phase}
		<WaitingRoom
			{phase}
			code={shownCode}
			address={page.url.host}
			{hostName}
			attempts={rendezvousFailure?.attempts ?? []}
			cause={rendezvousFailure instanceof UnreachableError ? rendezvousFailure.cause : 'timeout'}
			reason={unplayable}
			others={company.guests}
			onRetry={retryRendezvous}
			{name}
			onRename={isHost ? undefined : rename}
		/>
	{/if}

	<!--
		Capped at the window, and a flex column so the cap lands on the film rather
		than on everything under it. A 1080p film across the full 1024px of this
		block is 576px tall, which with the control bar, the header and the page's
		own padding put the player's bottom edge at y=700 of a 720px laptop window -
		so the row beneath it (who is watching, the invite link, the way off a wrong
		film) began at y=712 and was sliced in half by the fold. Every one of those
		facts was built to be read while the film plays, and none of them were.

		`100dvh` minus 6rem: the header (2rem plus its 1rem margin) and the page's
		1.5rem of padding at each end, which is everything between this block and the
		window. Only a cap - a film in a tall window still renders at its own size
		and the block hugs it, exactly as before.
	-->
	<div class="flex max-h-[calc(100dvh-6rem)] w-full max-w-5xl flex-col" class:hidden={!ready}>
		<div
			bind:this={player}
			class="player relative flex min-h-0 flex-col overflow-hidden rounded bg-black"
		>
			<!--
				`min-h-0` is what lets the film shrink under the cap at all, and
				`object-contain` is what keeps it the right shape when it does - the box
				loses height, the picture keeps its aspect ratio and gains bars, which
				are already the colour of the player behind them.
			-->
			<video
				bind:this={video}
				ontimeupdate={onTimeUpdate}
				onloadedmetadata={syncDuration}
				ondurationchange={syncDuration}
				onplay={syncPlayState}
				onpause={syncPlayState}
				onended={syncPlayState}
				class="min-h-0 w-full bg-black object-contain"
				data-testid="video"
				playsinline
			></video>

			<PlayerControls
				{video}
				container={player}
				{ready}
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
			<!--
				One explanation at a time, and the barrier's comes first. Both answer
				"why has the film stopped", and both can be true at once - a guest can
				run out of buffer under a film somebody had already paused - but the
				barrier's is the one with something still happening in it, and two
				banners stacked on one picture read as two separate faults.

				`playing` gates the attribution because the room's own play state is
				what makes it true: `pausedBy` is the last person to have stopped the
				film, which stops explaining anything the moment it runs again.
			-->
			{#if waitingOn.length || waitingOnYou}
				<BarrierNotice on={waitingOn} you={waitingOnYou} {started} />
			{:else if !playing && pausedBy && !pausedByYou}
				<PausedNotice by={pausedBy} />
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
		<!--
			The guest's half of the bar, and the last screen in the app where the room
			went unaccounted for. A host has been told who is here since the invite
			panel; a guest watching a film had a page consisting of the room code and a
			clock, so the people they came to watch WITH - the entire difference between
			this and opening the file alone - were nowhere on it. The names were live in
			the guest's own engine the whole time, learned from each peer's hello, and
			simply never left it.

			Under the player, exactly where the host reads the same fact, and gated on
			`ready` for the same reason HostBar is: the enclosing block stays mounted to
			preserve the <video>, so `hidden` would leave this in the DOM through every
			phase the waiting room is speaking for.
		-->
		{#if !isHost && ready}
			<!--
				The guest's counterpart of HostBar, and named here for the same reason it
				is there: this row is the room's people, and the reader is one of them.
				A guest who arrives after the film has started never sees the waiting
				room long enough to be asked anything, so without this the only people
				who could ever say who they are would be the ones who turned up early.
			-->
			<!--
				What they are watching, then who with. The host reads the same two facts
				in the same order under their own player - one film, one room, and no
				reason for the two ends of it to disagree about either.
			-->
			<NowPlaying title={film} testid="guest-now-playing" />
			<div class="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
				<Presence names={room} reader="guest" testid="company" />
				<NameTag {name} onRename={rename} testid="guest-name" />
			</div>
		{/if}

		<!--
			The two notes a playing film can carry about something that did NOT
			happen to it. Under the player and not over it: the film is fine and
			still running, and a banner on the picture would say otherwise.

			A failed switch is told to everyone - a guest who watched the host try
			and fail otherwise sees nothing change and has no idea whether the host
			knows. A guest who cannot play is the host's to read: the barrier has
			already let go of them, and this is the only account anyone gets of why
			one friend is not watching.
		-->
		{#if ready && switchFailed}
			<div class="mt-3">
				<FaultNotice
					fault={switchFailed.fault}
					lead="Couldn't switch to {switchFailed.title}. This video keeps playing."
					tone="note"
					testid="switch-failed"
				/>
			</div>
		{/if}
		{#if isHost && ready}
			{#each cannotPlay as c (c.peerId)}
				<div class="mt-3">
					<FaultNotice
						fault={c.fault}
						lead="{c.name}'s browser can't play this video, so the room isn't waiting for them."
						tone="note"
						testid="cannot-play"
					/>
				</div>
			{/each}
		{/if}

		{#if isHost && ready}
			<HostBar
				{shareUrl}
				{guests}
				{name}
				onRename={rename}
				title={film}
				note={converting}
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
		<div bind:this={changePicker} class="mt-6 flex w-full flex-col items-center">
			<FilePicker
				{onFile}
				onReject={(fault) => (unplayable = fault)}
				busy={reading}
				rejected={unplayable}
			/>
		</div>
	{/if}
</main>

<style>
	/**
	 * Fullscreen lands on the wrapper, not the video, so the controls come with
	 * it.
	 *
	 * The column, the shrinking film and its `object-contain` are the wrapper's
	 * own utilities now, and serve both modes. All fullscreen still asks for is
	 * that the film *grow*, rather than hugging its aspect ratio: the bar takes
	 * itself out of flow here and lies over the foot of the picture, so the film
	 * is the only thing left in the column and there is a whole screen for it to
	 * fill - which is the entire point of having asked for one.
	 */
	.player:fullscreen video {
		flex: 1;
	}
</style>
