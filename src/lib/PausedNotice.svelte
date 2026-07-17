<script lang="ts">
	/**
	 * Why the film just stopped, when a person is why.
	 *
	 * Anyone in the room can pause it for everyone: a guest's play button sends
	 * intent and the host obeys (PLAN.md 4.9). So a film halting for reasons
	 * entirely outside your room is the normal case, not the odd one - and the
	 * only account of it anybody got was the play button quietly flipping its
	 * glyph. Measured with two browsers: Bob pressed pause and the whole of
	 * Alice's screen carried on saying "Now playing tiny-60s.mp4 / Bob is here."
	 * over a picture that had stopped.
	 *
	 * The counterpart of BarrierNotice, which has answered the same question for
	 * the involuntary stop since the barrier existed: one of these two is on
	 * screen at a time, and between them a stopped film always says why.
	 *
	 * Never shown to whoever pressed pause - `you` is the host's answer off the
	 * wire, not a name match - because they are the one reader with no question
	 * to answer. And no "press play to resume": that button is right there under
	 * this, it works for every reader including a guest, and a notice that
	 * narrates the control beneath it is noise.
	 */

	let {
		by
	}: {
		/** The name of whoever paused it. Never the reader's own. */
		by: string;
	} = $props();
</script>

<!--
	Over the film and centred on it, exactly as BarrierNotice is, and for the
	reason it is: the film is stopped, so there is nothing underneath worth
	protecting, and fullscreen is how a film gets watched - anything that is a
	sibling of the player is not painted at all while that is up, which would
	withhold this from the very reader staring hardest at a picture that just
	froze.

	`pointer-events-none` because nothing here is a control, and the play button
	below it is.
-->
<div class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">
	<div
		class="flex max-h-full items-center gap-3 overflow-y-auto rounded bg-vanilla-500 px-4 py-3 shadow-lg"
		role="status"
		data-testid="paused-by"
	>
		<!-- A pause glyph, not a spinner: nothing is being worked on. -->
		<svg class="h-4 w-4 shrink-0" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			<rect x="4" y="3" width="3" height="10" rx="1" />
			<rect x="9" y="3" width="3" height="10" rx="1" />
		</svg>
		<p>{by} paused the film.</p>
	</div>
</div>
