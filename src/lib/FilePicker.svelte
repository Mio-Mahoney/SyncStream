<script lang="ts">
	/**
	 * The host's first move: hand the room a file off local disk.
	 *
	 * Drops land anywhere in the window rather than only on the box. Aiming a
	 * dragged file at a small target is the fiddly part of drag-and-drop, and
	 * there is nothing else on this page a file could sensibly be dropped onto.
	 */

	type Props = {
		onFile: (file: File) => void;
		/** Anything we can answer without touching the probe: folders, non-video, several at once. */
		onReject: (reason: string) => void;
		/** A file is being read. Picking a second one now would race the first. */
		busy?: boolean;
	};

	let { onFile, onReject, busy = false }: Props = $props();

	let dragging = $state(false);
	let chosen = $state('');

	/**
	 * dragenter/dragleave fire for every element the pointer crosses, so a plain
	 * boolean flickers off the moment the cursor passes onto a child. Counting
	 * enters against leaves is what keeps the highlight lit across the crossing.
	 */
	let depth = 0;

	/** Dragging selected text or a link must not light the page up. Only files may. */
	const carriesFile = (dt: DataTransfer | null) => !!dt && [...dt.types].includes('Files');

	function onDragEnter(e: DragEvent) {
		if (busy || !carriesFile(e.dataTransfer)) return;
		e.preventDefault();
		depth++;
		dragging = true;
	}

	function onDragOver(e: DragEvent) {
		if (busy || !carriesFile(e.dataTransfer)) return;
		// Without this the browser navigates away to the file instead of letting
		// the page have it, which loses the room.
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
	}

	function onDragLeave(e: DragEvent) {
		if (!carriesFile(e.dataTransfer)) return;
		depth = Math.max(0, depth - 1);
		if (depth === 0) dragging = false;
	}

	function onDrop(e: DragEvent) {
		depth = 0;
		dragging = false;
		if (!carriesFile(e.dataTransfer)) return;
		e.preventDefault();
		if (busy) return;
		take(e.dataTransfer!.files, e.dataTransfer!.items);
	}

	function onChange(e: Event) {
		const el = e.target as HTMLInputElement;
		take(el.files, null);
		// Let the same file be picked twice. Without this, re-picking the path
		// that just failed fires no change event at all and the click looks dead.
		el.value = '';
	}

	function take(files: FileList | null, items: DataTransferItemList | null) {
		// A dragged folder arrives as one entry-less File, so the only way to tell
		// it from a video is to ask the entry rather than the file.
		const entry = items?.[0]?.webkitGetAsEntry?.();
		if (entry?.isDirectory) {
			onReject(`"${entry.name}" is a folder. Drop the video file inside it instead.`);
			return;
		}
		if (!files?.length) return;
		if (files.length > 1) {
			onReject('Drop one video at a time. A room plays a single file.');
			return;
		}

		const file = files[0];
		// An empty type means the browser did not recognise the extension, which
		// is not the same as knowing it is not a video: the probe reads the actual
		// bytes and gives a far better answer than a guess from the name would.
		if (file.type && !file.type.startsWith('video/')) {
			onReject(`"${file.name}" is not a video file.`);
			return;
		}
		chosen = file.name;
		onFile(file);
	}
</script>

<svelte:window
	ondragenter={onDragEnter}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}
/>

{#if dragging}
	<!--
		The whole window is the drop target, so the whole window is what lights up.
		The scrim has to be heavy enough that the page reads as inert behind one
		instruction; a light one leaves the picker below competing with this for
		attention while both say the same thing.

		pointer-events-none so the drop still reaches the window handler above.
	-->
	<div
		class="pointer-events-none fixed inset-0 z-20 flex items-center justify-center bg-moonstone-900/80 backdrop-blur-sm"
		data-testid="drop-overlay"
	>
		<p
			class="rounded-lg border-2 border-dashed border-vanilla-100 px-12 py-10 text-3xl text-vanilla-100"
		>
			Drop it to play it here
		</p>
	</div>
{/if}

<!-- No lit state: while a file is over the page the overlay covers this entirely. -->
<label
	class="mb-4 flex w-full max-w-xl cursor-pointer flex-col items-center rounded-lg border-2 px-8 py-12 text-center transition focus-within:ring-2 focus-within:ring-moonstone-500 {busy
		? 'cursor-progress border-solid border-moonstone-300 bg-white/50'
		: 'border-dashed border-moonstone-400 bg-white/50 hover:border-moonstone-500 hover:bg-white/80'}"
	data-testid="file-picker"
>
	<input
		type="file"
		accept="video/*"
		class="sr-only"
		onchange={onChange}
		disabled={busy}
		data-testid="file-input"
	/>

	{#if busy}
		<span class="spinner mb-3" aria-hidden="true"></span>
		<span class="max-w-full truncate font-mono text-lg" data-testid="chosen-file">{chosen}</span>
	{:else}
		<svg
			class="mb-3 h-10 w-10 text-moonstone-500"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M12 16V4" />
			<path d="m7 9 5-5 5 5" />
			<path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
		</svg>
		<span class="text-lg">Drop a video here, or <u>browse</u></span>
		<span class="mt-1 block text-sm text-moonstone-800">It never leaves your machine.</span>
	{/if}
</label>

<style>
	.spinner {
		width: 2rem;
		height: 2rem;
		border-radius: 9999px;
		border: 4px solid theme('colors.moonstone.200');
		border-top-color: theme('colors.moonstone.500');
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2.4s;
		}
	}
</style>
