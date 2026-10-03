// Transport selection (role 07, R-N1): without the build-time define the app talks to the hub and
// exposes no fixture controls; fixture mode exposes them; one transport per page and mode.
import { describe, expect, test } from "bun:test";
import {
	FIXTURE_CONTROLS_GLOBAL,
	loadWorkspaceTransport,
	transportMode,
} from "./config.ts";

const G = globalThis as Record<string, unknown>;

describe("transport selection", () => {
	test("default (no define) is the hub, with no fixture global", async () => {
		expect(transportMode()).toBe("hub");
		const t = await loadWorkspaceTransport();
		expect(t.source).toBe("hub");
		expect(FIXTURE_CONTROLS_GLOBAL in G).toBe(false);
	});

	test("fixture mode exposes the controls global; repeated loads share one world", async () => {
		const [a, b] = await Promise.all([
			loadWorkspaceTransport("fixture"),
			loadWorkspaceTransport("fixture"),
		]);
		expect(a.source).toBe("fixture");
		expect(a).toBe(b); // React StrictMode mounts twice: still one fixture world
		expect(G[FIXTURE_CONTROLS_GLOBAL]).toBe(
			(a as unknown as { controls: unknown }).controls,
		);
		expect(await loadWorkspaceTransport("hub")).toBe(
			await loadWorkspaceTransport(),
		);
		delete G[FIXTURE_CONTROLS_GLOBAL];
	});
});
