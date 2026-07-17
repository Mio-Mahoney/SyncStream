<script lang="ts">
	/**
	 * The host's half of the wait, and the counterpart to WaitingRoom.
	 *
	 * A host who has just opened a room is doing two things at once: finding a
	 * file, and getting people in. The picker speaks for the first. Nothing spoke
	 * for the second - the invite was a small button in the far corner, and the
	 * arrivals it was supposed to produce were invisible until playback started,
	 * so a host waiting for friends had no way to tell whether to keep waiting or
	 * start without them.
	 *
	 * Once the film starts this gives way to HostBar, which carries the same two
	 * facts at the weight they deserve by then.
	 */

	import CopyLink from '$lib/CopyLink.svelte';
	import NameTag from '$lib/NameTag.svelte';
	import Presence from '$lib/Presence.svelte';

	let {
		shareUrl,
		guests,
		name,
		onRename
	}: {
		shareUrl: string;
		guests: readonly { peerId: string; name: string }[];
		/** What the room calls the host - "Host" until they say otherwise. */
		name: string;
		onRename: (name: string) => void;
	} = $props();
</script>

<section
	class="mb-4 w-full max-w-xl rounded-xl border border-moonstone-200 bg-white/70 p-6"
	data-testid="invite-panel"
>
	<h2 class="text-lg font-medium">Invite people</h2>
	<p class="mt-1 text-sm text-moonstone-800">
		Send this link. It opens the room straight away, with no code to type. It works now - they can
		arrive while you pick a video.
	</p>

	<div class="mt-4">
		<CopyLink {shareUrl} />
	</div>

	<!--
		Beside the arrivals, because it is the same subject read from the other end:
		this line is who they will see when they get here, and that line is who has.
		Before the film is the moment a host has to spare for it, and the moment it
		pays off - a guest who arrives after this reads the host's real name on the
		hello rather than learning it later.
	-->
	<div
		class="mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-moonstone-100 pt-4"
	>
		<Presence names={guests.map((g) => g.name)} testid="invite-guests" />
		<NameTag {name} {onRename} testid="host-name" />
	</div>
</section>
