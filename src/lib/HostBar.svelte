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
	import Presence from '$lib/Presence.svelte';

	let {
		shareUrl,
		guests,
		barrierEnabled,
		onToggleBarrier
	}: {
		shareUrl: string;
		guests: readonly { peerId: string; name: string }[];
		barrierEnabled: boolean;
		onToggleBarrier: () => void;
	} = $props();
</script>

<div class="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
	<Presence {guests} testid="guests" />

	<div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-moonstone-800">
		<label class="flex cursor-pointer items-center gap-2">
			<input type="checkbox" checked={barrierEnabled} onchange={onToggleBarrier} />
			Pause when someone falls behind
		</label>
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
