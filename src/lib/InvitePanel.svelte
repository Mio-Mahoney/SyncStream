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
	import Presence from '$lib/Presence.svelte';

	let {
		shareUrl,
		guests
	}: {
		shareUrl: string;
		guests: readonly { peerId: string; name: string }[];
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

	<div class="mt-5 border-t border-moonstone-100 pt-4">
		<Presence names={guests.map((g) => g.name)} testid="invite-guests" />
	</div>
</section>
