<script lang="ts">
	/**
	 * One fault, rendered the one way.
	 *
	 * Every failure a person reads in this app arrives as a `Fault` (see
	 * protocol/control): a cause, a sentence about it, and what to do if there
	 * is anything. This is the only place that shape is turned into markup, so
	 * a picker rejection, a guest's "that won't play here" and a failed film
	 * switch all read alike, and a test can find any of them by `data-fault`.
	 *
	 * `lead` is the sentence that puts the fault in context for this reader -
	 * "Couldn't switch to X." - when the detail alone, written for whoever owns
	 * the failed thing, would land without a subject.
	 */
	import type { Fault } from '$lib/protocol/control';

	let {
		fault,
		lead = '',
		tone = 'error',
		testid = 'fault'
	}: {
		fault: Fault;
		lead?: string;
		/** A note about something that did not happen is quieter than something broken. */
		tone?: 'error' | 'note';
		testid?: string;
	} = $props();
</script>

<div
	class="rounded px-4 py-3 {tone === 'error'
		? 'bg-tangerine-100 text-tangerine-900'
		: 'bg-vanilla-500 text-moonstone-900'}"
	role="alert"
	data-testid={testid}
	data-fault={fault.code}
>
	{#if lead}
		<p class="font-medium">{lead}</p>
	{/if}
	<p class={lead ? 'mt-1' : ''}>{fault.detail}</p>
	{#if fault.remedy}
		<p class="mt-1 text-sm opacity-90" data-testid="{testid}-remedy">{fault.remedy}</p>
	{/if}
</div>
