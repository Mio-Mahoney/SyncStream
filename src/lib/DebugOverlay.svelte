<script lang="ts">
	import { stats } from '$lib/stats.svelte';

	const mbps = (bytesPerSec: number) => ((bytesPerSec * 8) / 1_000_000).toFixed(2);
	const secs = (n: number) => n.toFixed(2);

	/**
	 * PLAN.md 9: this is the only field here that is not decoration. Every
	 * `relay` is a connection that would have needed TURN; every host/srflx is
	 * one that did not.
	 */
	const candidateColor = $derived(
		stats.candidateType === 'relay'
			? 'text-tangerine-300'
			: stats.candidateType === 'unknown'
				? 'text-white/50'
				: 'text-moonstone-300'
	);
</script>

<div
	class="fixed top-2 right-2 z-50 w-[22rem] max-w-[calc(100vw-1rem)] rounded bg-black/85 p-3 font-mono text-[11px] leading-5 text-white shadow-lg"
	data-testid="debug-overlay"
>
	<div class="mb-1 flex justify-between border-b border-white/20 pb-1">
		<span>syncstream {stats.role ?? '-'}</span>
		<span class="text-white/60">{stats.room ?? '-'} via {stats.strategy ?? '-'}</span>
	</div>

	<dl class="grid grid-cols-2 gap-x-3">
		<dt class="text-white/60">ice</dt>
		<dd>
			{stats.iceState}
			<span class={candidateColor}>({stats.candidateType})</span>
		</dd>

		<dt class="text-white/60">throughput</dt>
		<dd>{mbps(stats.throughputBps)} Mbps</dd>

		<dt class="text-white/60">buffer ahead</dt>
		<dd>{secs(stats.bufferedAhead)}s</dd>

		<dt class="text-white/60">rtt</dt>
		<dd>{stats.rtt.toFixed(0)}ms</dd>

		<dt class="text-white/60">clock offset</dt>
		<dd>{stats.clockOffset.toFixed(0)}ms</dd>

		<dt class="text-white/60">drift</dt>
		<dd class={Math.abs(stats.drift) > 0.1 ? 'text-tangerine-300' : ''}>
			{(stats.drift * 1000).toFixed(0)}ms
		</dd>

		<dt class="text-white/60">rung</dt>
		<dd>{stats.rung ?? '-'} of [{stats.availableRungs.join(',')}]</dd>

		<dt class="text-white/60">seg queue</dt>
		<dd>{stats.segmentQueue}</dd>

		<dt class="text-white/60">media</dt>
		<dd>{secs(stats.mediaTime)}s {stats.playing ? 'playing' : 'paused'}</dd>

		<dt class="text-white/60">tier</dt>
		<dd>{stats.tier ?? '-'}</dd>

		<dt class="text-white/60">ttff</dt>
		<dd>{stats.ttff === null ? '-' : `${stats.ttff.toFixed(0)}ms`}</dd>
	</dl>

	{#if stats.waitingOn.length}
		<div class="mt-1 border-t border-white/20 pt-1 text-tangerine-300">
			waiting on {stats.waitingOn.join(', ')}
		</div>
	{/if}

	{#if stats.peers.length}
		<div class="mt-1 border-t border-white/20 pt-1">
			{#each stats.peers as p (p.peerId)}
				<div class="flex justify-between gap-2">
					<span class="truncate">{p.name || p.peerId.slice(0, 6)} ({p.role})</span>
					<span class="shrink-0 text-white/70">
						{mbps(p.throughputBps)}M {secs(p.bufferedAhead)}s r{p.rung ?? '-'}
						{p.candidateType}
					</span>
				</div>
			{/each}
		</div>
	{/if}
</div>
