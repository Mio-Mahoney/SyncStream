/**
 * The slice of HTMLMediaElement the sync engine touches, as a plain object.
 * Events are dispatched by name; `play()` resolves and clears `paused`.
 */
export class FakeVideo {
	paused = true;
	ended = false;
	seeking = false;
	readyState = 4;
	currentTime = 0;
	duration = 600;
	playbackRate = 1;
	seeks: number[] = [];
	readonly listeners = new Map<string, Set<() => void>>();

	addEventListener(type: string, cb: () => void): void {
		let set = this.listeners.get(type);
		if (!set) this.listeners.set(type, (set = new Set()));
		set.add(cb);
	}
	removeEventListener(type: string, cb: () => void): void {
		this.listeners.get(type)?.delete(cb);
	}
	fire(type: string): void {
		for (const cb of [...(this.listeners.get(type) ?? [])]) cb();
	}
	play(): Promise<void> {
		this.paused = false;
		return Promise.resolve();
	}
	pause(): void {
		this.paused = true;
	}
	/** A test-side seek that records itself. Assigning currentTime is how the engine seeks. */
	seekTo(t: number): void {
		this.currentTime = t;
	}
}

/** Wraps a FakeVideo so assignments to currentTime are observable as seeks. */
export function fakeVideo(): FakeVideo & HTMLMediaElement {
	const v = new FakeVideo();
	let time = 0;
	Object.defineProperty(v, 'currentTime', {
		get: () => time,
		set: (t: number) => {
			time = t;
			v.seeks.push(t);
		}
	});
	return v as unknown as FakeVideo & HTMLMediaElement;
}
