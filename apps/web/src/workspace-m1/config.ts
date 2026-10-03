// Transport selection (role 07, lead ruling R-N1): a BUILD-TIME Vite `define` constant, never a
// URL parameter or runtime toggle. Default = the real hub.
//
//   define: { __AGENTCITY_WORKSPACE_FIXTURE__: "true" }   → UI fixture (data-source=fixture)
//   (absent / anything else)                              → hub (fetch transport)
//
// In fixture mode the fixture CONTROLS are exposed as a global for tests / browser QA (FX set);
// they are never rendered. The fixture module is loaded with a dynamic import so a hub build
// never executes (and only lazily ships) fixture code.
import { createFetchTransport } from "./fetch-transport.ts";
import type { WorkspaceTransport } from "./transport.ts";

declare const __AGENTCITY_WORKSPACE_FIXTURE__: boolean | undefined;

export type TransportMode = "hub" | "fixture";

/** Name of the global that carries the fixture controls (fixture builds only). */
export const FIXTURE_CONTROLS_GLOBAL =
	"__AGENTCITY_WORKSPACE_FIXTURE_CONTROLS__";

export function transportMode(): TransportMode {
	return typeof __AGENTCITY_WORKSPACE_FIXTURE__ !== "undefined" &&
		__AGENTCITY_WORKSPACE_FIXTURE__ === true
		? "fixture"
		: "hub";
}

/** One transport per page and mode (React StrictMode mounts twice; the fixture world must be one). */
const cache = new Map<TransportMode, Promise<WorkspaceTransport>>();

export function loadWorkspaceTransport(
	mode: TransportMode = transportMode(),
): Promise<WorkspaceTransport> {
	const hit = cache.get(mode);
	if (hit) return hit;
	const made: Promise<WorkspaceTransport> =
		mode === "fixture"
			? import("./fixture-transport.ts").then(({ createFixtureTransport }) => {
					const t = createFixtureTransport();
					(globalThis as Record<string, unknown>)[FIXTURE_CONTROLS_GLOBAL] =
						t.controls;
					return t;
				})
			: Promise.resolve(createFetchTransport());
	cache.set(mode, made);
	return made;
}
