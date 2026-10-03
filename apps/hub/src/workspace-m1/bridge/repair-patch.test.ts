// L-11 repair policy of the patched engine (lead applied `orchestrator-repair.patch`; NOTES.md
// "Orchestrator repair patch"): a finding outside the approved scope or with an unsafe path never
// starts a repair, and authorization is re-checked on the fresh row right before a repair opens.
import { afterEach, describe, expect, test } from "bun:test";
import type { Finding } from "@agent-city/schema";
import type { WorkspaceDraft } from "@agent-city/schema/workspace-m1";
import {
	approved,
	type BridgeEnv,
	draft,
	engineOf,
	makeBridgeEnv,
	resultRequests,
	runsOf,
	scriptedReviewer,
	stageOf,
	tracker,
} from "./test-support.ts";

const t = tracker();
afterEach(() => t.cleanup());

const finding = (file: string): Finding => ({
	severity: "major",
	title: "Scripted defect",
	detail: "Scripted reviewer finding for the repair-policy tests.",
	file,
	line: 1,
	actionable: true,
});

/** Attempt 1 is rejected with `files` as actionable findings; any later attempt is approved. */
async function rejectedWith(
	files: string[],
	d: WorkspaceDraft,
	alsoDeny?: () => string | null,
	onReview?: () => void,
): Promise<{ env: BridgeEnv; managedTaskId: string; taskId: string }> {
	const env = t.track(
		makeBridgeEnv({
			adapters: (base) =>
				scriptedReviewer(base, (input) => {
					onReview?.();
					return input.run.attempt_no === 1 ? files.map(finding) : "approve";
				}),
		}),
	);
	const v = await env.ctx();
	const ids = await approved(env, v, d);
	await env.drain(env.engine(alsoDeny ? { alsoDeny } : {}));
	return { env, managedTaskId: ids.managedTaskId, taskId: ids.taskId };
}

const srcScope = draft({
	scope: { allowed: ["src"], protected: [] },
	repair_policy: { max_repairs: 1 },
});
const rootScope = draft({ repair_policy: { max_repairs: 1 } });

describe("L-11: a finding that needs a path outside the approved scope", () => {
	test("no repair: scope_violation on attempt 1, execution_ended, nothing offered", async () => {
		const { env, managedTaskId, taskId } = await rejectedWith(
			["README.md"],
			srcScope,
		);
		const m = engineOf(env, managedTaskId);
		expect(runsOf(env, managedTaskId)).toHaveLength(1);
		expect(m?.state).toBe("failed");
		expect(m?.failure_kind).toBe("scope_violation");
		expect(m?.state_detail).toContain("outside the approved scope");
		expect(env.calls.implement).toBe(1);
		expect(stageOf(env, taskId)).toBe("execution_ended");
		expect(resultRequests(env, taskId)).toHaveLength(0);
	});
});

describe("L-11: unsafe finding paths (absolute, parent-traversing) even with scope '.'", () => {
	test("no repair: scope_violation; unsafe paths are never echoed", async () => {
		const { env, managedTaskId } = await rejectedWith(
			["../escape.txt", "/abs/outside.txt"],
			rootScope,
		);
		const m = engineOf(env, managedTaskId);
		expect(runsOf(env, managedTaskId)).toHaveLength(1);
		expect(m?.failure_kind).toBe("scope_violation");
		expect(m?.state_detail).toContain("[unsafe path]");
		expect(m?.state_detail).not.toContain("/abs/");
	});
});

describe("L-11: authorization revoked while the review ran", () => {
	const revoke = () => {
		let revoked = false;
		return {
			alsoDeny: () => (revoked ? "revoked during the review" : null),
			onReview: () => {
				revoked = true;
			},
		};
	};

	test("re-checked before the repair: no repair attempt exists; approval_void on attempt 1", async () => {
		const r = revoke();
		const { env, managedTaskId } = await rejectedWith(
			["src/app.txt"],
			srcScope,
			r.alsoDeny,
			r.onReview,
		);
		const m = engineOf(env, managedTaskId);
		expect(runsOf(env, managedTaskId)).toHaveLength(1);
		expect(m?.state).toBe("blocked");
		expect(m?.failure_kind).toBe("approval_void");
		expect(m?.state_detail).toContain("not authorized to repair");
	});
});
