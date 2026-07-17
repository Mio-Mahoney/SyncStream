<script lang="ts">
	/**
	 * The host's chrome under a playing video, and what the invite panel becomes
	 * once the film starts.
	 *
	 * The two facts the panel carried do not stop mattering when playback begins:
	 * a host still wants to know who is watching, and still needs the link to let
	 * a latecomer in. This used to be a bare "1 watching" count next to a corner
	 * button that swallowed every clipboard refusal, so both got quietly worse at
	 * the exact moment there were finally people to lose.
	 */

	import CopyLink from '$lib/CopyLink.svelte';
	import NameTag from '$lib/NameTag.svelte';
	import NowPlaying from '$lib/NowPlaying.svelte';
	import Presence from '$lib/Presence.svelte';

	let {
		shareUrl,
		guests,
		name,
		onRename,
		title,
		note = '',
		barrierEnabled,
		onToggleBarrier,
		changing,
		onToggleChanging
	}: {
		shareUrl: string;
		guests: readonly { peerId: string; name: string }[];
		/** What the room calls the host - "Host" until they say otherwise. */
		name: string;
		onRename: (name: string) => void;
		/**
		 * The film that is on. It answers the question "Change video" begs and
		 * never used to: that button opens a picker reading "Drop a video here",
		 * with nothing anywhere saying which film it is offering to replace.
		 */
		title: string;
		/**
		 * Something about the film that is on, true for as long as it is - today,
		 * only that it is being converted as it streams rather than played off
		 * disk. It belongs here because it is the host's fact about the host's
		 * film, and this is what the host reads under one; the page top, where it
		 * used to live, had nothing else on it by then and never cleared.
		 */
		note?: string;
		barrierEnabled: boolean;
		onToggleBarrier: () => void;
		/** The picker is open below, waiting for a file to replace this one. */
		changing: boolean;
		onToggleChanging: () => void;
	} = $props();
</script>

<NowPlaying {title} testid="host-now-playing" />

{#if note}
	<!--
		Its own line above the row rather than a chip inside it: this is a sentence,
		and the row is controls. Quiet, because nothing is wrong - it explains why
		the machine is working hard, and there is nothing to do about it.
	-->
	<p class="mt-3 text-sm text-moonstone-800" data-testid="host-note">{note}</p>
{/if}

<div class="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
	<!--
		Who is here, and who they are watching it with, as one group: the two halves
		of the room's population, one of which is the reader.
	-->
	<div class="flex flex-wrap items-center gap-x-4 gap-y-1">
		<Presence names={guests.map((g) => g.name)} testid="guests" />
		<NameTag {name} {onRename} testid="host-name" />
	</div>

	<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-moonstone-800">
		<label class="flex cursor-pointer items-center gap-2">
			<input type="checkbox" checked={barrierEnabled} onchange={onToggleBarrier} />
			Pause when someone falls behind
		</label>
		<!--
			The only way off a film once it is on. The picker unmounted the moment a
			file was accepted, so a host who put on the wrong one could reach it again
			only by reloading - which, for a host, ends the room and evicts everybody
			over a misclick.
		-->
		<button
			type="button"
			class="rounded border border-moonstone-400 px-3 py-1 transition hover:border-moonstone-500 hover:bg-white/80 focus-visible:ring-2 focus-visible:ring-moonstone-500 focus-visible:outline-none"
			onclick={onToggleChanging}
			aria-expanded={changing}
			data-testid="change-video"
		>
			{changing ? 'Keep this video' : 'Change video'}
		</button>
		<!--
			min-w-0 so the link field the compact variant reveals on a refused
			clipboard can shrink into whatever room is left rather than pushing the
			bar wider than the player.
		-->
		<div class="min-w-0">
			{#if shareUrl}
				<CopyLink {shareUrl} variant="compact" label="Copy invite link" />
			{/if}
		</div>
	</div>
</div>
