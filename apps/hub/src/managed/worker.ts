// The single in-hub worker: a loop around Orchestrator.tick(), plus the adapter composition root.
// Live CLI adapters are only constructed when the config's master switch is on and both provider
// blocks exist — with the default config no provider executable is ever spawned.
import { redact } from "@agent-city/schema";
import { createClaudeImplementer } from "./adapters/claude.ts";
import { createCodexReviewer } from "./adapters/codex.ts";
import { fakeImplementer, fakeReviewer } from "./adapters/fake.ts";
import type { AdapterSet } from "./adapters/types.ts";
import type { ManagedConfig } from "./config.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { liveConfigured } from "./service.ts";

export function createAdapters(config: ManagedConfig): AdapterSet {
	const live = liveConfigured(config);
	const claude =
		live && config.live.claude
			? createClaudeImplementer(config.live.claude)
			: null;
	const codex =
		live && config.live.codex ? createCodexReviewer(config.live.codex) : null;
	return {
		implementer: (mode) => (mode === "simulated" ? fakeImplementer : claude),
		reviewer: (mode) => (mode === "simulated" ? fakeReviewer : codex),
	};
}

export interface Worker {
	/** Wake the loop now (a task was queued or cancelled). */
	poke(): void;
	stop(): Promise<void>;
}

/** Poll for work every `idleMs`; ticks never overlap. Errors are logged as a message only. */
export function startWorker(
	orchestrator: Orchestrator,
	idleMs = 1_000,
): Worker {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let busy: Promise<void> | null = null;
	let again = false;

	const loop = async () => {
		if (stopped) return;
		if (busy) {
			again = true;
			return;
		}
		busy = (async () => {
			try {
				while (!stopped && (await orchestrator.tick())) {
					// keep going while there is work
				}
			} catch (err) {
				console.error(
					`[managed] worker tick failed: ${redact((err as Error).message)}`,
				);
			}
		})();
		await busy;
		busy = null;
		if (stopped) return;
		clearTimeout(timer);
		if (again) {
			again = false;
			void loop();
		} else timer = setTimeout(loop, idleMs);
	};
	void loop();

	return {
		poke() {
			clearTimeout(timer);
			void loop();
		},
		async stop() {
			stopped = true;
			clearTimeout(timer);
			await orchestrator.shutdown();
			await busy;
		},
	};
}
