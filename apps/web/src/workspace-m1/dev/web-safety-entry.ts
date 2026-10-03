// Web-safety probe (role 07, dev only; never imported by the app). Re-exports the WHOLE web-safe
// contract barrel so a browser bundle of this entry must contain every module reachable from
// `@agent-city/schema/workspace-m1` (Rollup keeps an entry's exports). `web-safety-build.ts`
// bundles it with a programmatic Vite build and fails on any externalized / Node-only module.
export * from "@agent-city/schema/workspace-m1";

import {
	criteriaFromText,
	DecisionRequest,
	deriveWorkspacePhase,
	WORKSPACE_ROUTES,
	WorkspaceSnapshot,
} from "@agent-city/schema/workspace-m1";

/** Executes a few contract functions so the probe also proves they run (not just bundle). */
export function probe(): Record<string, unknown> {
	return {
		criteria: criteriaFromText("a, b\r\nc"),
		phase: deriveWorkspacePhase("running", "verifying"),
		routes: Object.keys(WORKSPACE_ROUTES).length,
		snapshotRejectsEmpty: WorkspaceSnapshot.safeParse({}).success === false,
		decisionRejectsEmpty: DecisionRequest.safeParse({}).success === false,
	};
}
