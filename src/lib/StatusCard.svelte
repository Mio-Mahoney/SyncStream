<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	/**
	 * The card every screen without a film on it is drawn in: the waits and dead
	 * ends of a room (WaitingRoom), and the dead ends that are not a room's
	 * (+error.svelte).
	 *
	 * One component because they must not drift. To the person looking at any of
	 * them it is the same situation - the film is not playing from here, now
	 * what? - and two cards that had been restyled apart would read as two
	 * products answering.
	 */
	let { children, ...rest }: { children: Snippet } & HTMLAttributes<HTMLElement> = $props();
</script>

<section
	class="mt-12 w-full max-w-md rounded-xl border border-moonstone-200 bg-white/70 p-8 text-center"
	{...rest}
>
	{@render children()}
</section>
