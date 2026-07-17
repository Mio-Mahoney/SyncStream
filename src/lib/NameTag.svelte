<script lang="ts">
	/**
	 * Who the reader is in this room, and the one control that changes it.
	 *
	 * This is the only place the app has ever told you your own name. Everything
	 * else here reports on other people - presence, the roster, the barrier - and
	 * all of it was rendering names a machine invented, because there was nothing
	 * anywhere to say who you actually are.
	 *
	 * Mounted at all four sites the room reports its people from: the host's
	 * invite panel and bar under the player, and the guest's waiting room and
	 * line under the player. Both roles, both sides of the film starting - a
	 * name you can only set before the film would be no use to the guest who
	 * arrived during it, and one you can only set during it would be no use to
	 * the host watching an invite panel for arrivals.
	 */

	import { NAME_MAX, normalizeName } from '$lib/identity';
	import { tick } from 'svelte';

	let {
		name,
		onRename,
		testid = 'name-tag'
	}: {
		/** What the room currently calls the reader. */
		name: string;
		/** Normalized and non-empty; the tag refuses to send anything else. */
		onRename: (name: string) => void;
		testid?: string;
	} = $props();

	let editing = $state(false);
	let draft = $state('');
	let field = $state<HTMLInputElement>();

	async function open() {
		draft = name;
		editing = true;
		// The field does not exist until Svelte has flushed the reveal, so the
		// focus that makes this a control rather than a box to go and find has to
		// wait for it.
		await tick();
		field?.select();
	}

	function save() {
		const next = normalizeName(draft);
		// An empty name would leave the room with nothing to call them, and every
		// sentence built on it ("... is here") reading as a typo. Keeping the one
		// they have is the only other honest answer.
		if (next && next !== name) onRename(next);
		editing = false;
	}
</script>

{#if editing}
	<!--
		A form so Enter submits. Naming yourself is one field and one word; being
		made to leave the keyboard to find a button would be the toll this is
		meant not to be.
	-->
	<form
		class="flex items-center gap-2 text-sm"
		onsubmit={(e) => {
			e.preventDefault();
			save();
		}}
	>
		<label class="text-moonstone-800" for="{testid}-field">Your name</label>
		<input
			id="{testid}-field"
			bind:this={field}
			bind:value={draft}
			maxlength={NAME_MAX}
			autocomplete="nickname"
			spellcheck="false"
			data-testid="{testid}-field"
			onkeydown={(e) => e.key === 'Escape' && (editing = false)}
			class="w-36 rounded border border-moonstone-400 bg-white px-2 py-1 outline-none focus:border-moonstone-500"
		/>
		<button
			type="submit"
			data-testid="{testid}-save"
			class="rounded border border-moonstone-400 px-2 py-1 transition hover:bg-white/80 focus-visible:ring-2 focus-visible:ring-moonstone-500 focus-visible:outline-none"
		>
			Save
		</button>
	</form>
{:else}
	<p class="flex items-center gap-2 text-sm text-moonstone-800" data-testid={testid}>
		<span
			>You're <b class="font-medium text-moonstone-900" data-testid="{testid}-name">{name}</b></span
		>
		<button
			type="button"
			onclick={open}
			data-testid="{testid}-edit"
			class="rounded px-1 underline decoration-moonstone-400 underline-offset-2 transition hover:text-moonstone-900 focus-visible:ring-2 focus-visible:ring-moonstone-500 focus-visible:outline-none"
		>
			Change
		</button>
	</p>
{/if}
