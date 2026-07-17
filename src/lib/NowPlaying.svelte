<script lang="ts">
	/**
	 * The film's name, under the player, for whoever is watching it.
	 *
	 * Every other fact about the room has had a home under the player since
	 * iterations of presence work - who is here, who you are watching with, who it
	 * is waiting on - and the film itself had none, on either side. See film.ts.
	 *
	 * The same line for both roles, deliberately. Unlike presence ("Guest 4 is
	 * here" vs "Watching with Alice"), this fact does not change with its reader:
	 * the host and their guests are watching one film, and the whole point of the
	 * line is that they agree on which.
	 */
	let { title, testid }: { title: string; testid: string } = $props();
</script>

<!--
	`truncate` and not a shorter string: a long filename must not push the row wider
	than the player, and the tooltip is where the whole name stays - unlike the
	wire's cap in film.ts, nothing is lost here. `min-w-0` because this is a flex
	child of the room block, and truncate does nothing to a child that will not
	shrink under its own content.
-->
<p
	class="mt-3 min-w-0 truncate text-sm text-moonstone-800"
	{title}
	data-testid={testid}
	data-title={title}
>
	<span class="text-moonstone-700">Now playing</span>
	<b class="ml-1 font-medium text-moonstone-900">{title}</b>
</p>
