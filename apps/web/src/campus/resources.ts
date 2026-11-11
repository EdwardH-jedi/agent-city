// Disposal registry: every GPU resource, listener, observer and frame request the scene creates is
// recorded here at creation time, and `disposeAll()` releases them in reverse order. Idempotent;
// anything tracked after disposal is released immediately; one failing release never stops the
// rest. Pure TypeScript (unit-tested with stubs and with real three objects, no WebGL).

export interface DisposableLike {
	dispose(): void;
}

interface Entry {
	label: string;
	target: object | null;
	release: () => void;
}

export class DisposalRegistry {
	private entries: Entry[] = [];
	private readonly targets = new Set<object>();
	private done = false;
	private failures: string[] = [];

	/** Record a resource with a `dispose()` method. Tracking the same object twice is a no-op. */
	track<T extends DisposableLike>(resource: T, label = "resource"): T {
		if (this.targets.has(resource)) return resource;
		if (this.done) {
			this.run({ label, target: resource, release: () => resource.dispose() });
			return resource;
		}
		this.targets.add(resource);
		this.entries.push({
			label,
			target: resource,
			release: () => resource.dispose(),
		});
		return resource;
	}

	/** Record any other cleanup (listener removal, observer disconnect, frame cancel, DOM node). */
	defer(release: () => void, label = "cleanup"): void {
		const entry = { label, target: null, release };
		if (this.done) this.run(entry);
		else this.entries.push(entry);
	}

	has(resource: object): boolean {
		return this.targets.has(resource);
	}

	get size(): number {
		return this.entries.length;
	}

	get disposed(): boolean {
		return this.done;
	}

	/** Labels of releases that threw (they are swallowed so the rest still run). */
	get errors(): readonly string[] {
		return this.failures;
	}

	disposeAll(): void {
		if (this.done) return;
		this.done = true;
		const list = this.entries;
		this.entries = [];
		for (let i = list.length - 1; i >= 0; i -= 1) {
			const e = list[i];
			if (e) this.run(e);
		}
		this.targets.clear();
	}

	private run(e: Entry): void {
		try {
			e.release();
		} catch {
			this.failures = [...this.failures, e.label];
		}
	}
}
