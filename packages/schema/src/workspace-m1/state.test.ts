import { describe, expect, test } from "bun:test";
import { TaskState } from "../managed.ts";
import {
	ApprovalKind,
	ApprovalStatus,
	approvalStatusFor,
	CANCELLABLE_STAGES,
	canTransitionApproval,
	canTransitionWorkspace,
	DECISION_STAGE,
	DecisionAction,
	deriveWorkspacePhase,
	engineStageEffect,
	isActionAllowed,
	isDraftEditable,
	PUBLISHABLE_STAGES,
	RERUNNABLE_STAGES,
	stageAfterDecision,
	stageAfterSealing,
	TERMINAL_WORKSPACE_STAGES,
	WORKSPACE_TRANSITIONS,
	WorkspaceStage,
	WorkspaceTrigger,
} from "./index.ts";

const stages = WorkspaceStage.options;
const into = (to: WorkspaceStage) =>
	WORKSPACE_TRANSITIONS.filter((t) => t.to === to);

describe("workspace transition table", () => {
	test("every row uses known stages/triggers and is unique", () => {
		const keys = new Set<string>();
		for (const t of WORKSPACE_TRANSITIONS) {
			expect(stages).toContain(t.from);
			expect(stages).toContain(t.to);
			expect(WorkspaceTrigger.options).toContain(t.trigger);
			expect(t.actors.length).toBeGreaterThan(0);
			const k = `${t.from}>${t.to}>${t.trigger}`;
			expect(keys.has(k)).toBe(false);
			keys.add(k);
		}
	});

	test("terminal stages (accepted, rejected) go nowhere", () => {
		expect(TERMINAL_WORKSPACE_STAGES).toEqual(["accepted", "rejected"]);
		for (const s of TERMINAL_WORKSPACE_STAGES) {
			expect(WORKSPACE_TRANSITIONS.filter((t) => t.from === s)).toEqual([]);
			expect(isDraftEditable(s)).toBe(false);
		}
	});

	test("only an operator Gate-1 approval queues work", () => {
		expect(into("queued")).toEqual([
			{
				from: "awaiting_run_approval",
				to: "queued",
				trigger: "gate1_approve",
				actors: ["operator"],
			},
		]);
	});

	test("only an operator Gate-2 accept reaches accepted, only from awaiting_acceptance", () => {
		expect(into("accepted")).toEqual([
			{
				from: "awaiting_acceptance",
				to: "accepted",
				trigger: "gate2_accept",
				actors: ["operator"],
			},
		]);
	});

	test("Gate 2 opens only from an execution, only by the engine side", () => {
		for (const t of into("awaiting_acceptance")) {
			expect(["queued", "running"]).toContain(t.from);
			expect(t.trigger).toBe("result_ready");
			expect(t.actors).not.toContain("operator");
		}
	});

	test("the operator never moves an execution forward (running / awaiting_acceptance)", () => {
		for (const t of WORKSPACE_TRANSITIONS)
			if (["running", "awaiting_acceptance"].includes(t.to))
				expect(t.actors).not.toContain("operator");
	});

	test("cancel: confirmed only by the engine once something may be running", () => {
		for (const t of into("cancelled"))
			if (t.actors.includes("operator"))
				// nothing can be running yet: pending Gate 1, or queued with no worker lease
				expect(["awaiting_run_approval", "queued"]).toContain(t.from);
		expect(
			canTransitionWorkspace(
				"cancel_requested",
				"cancelled",
				"cancel",
				"operator",
			),
		).toBe(false);
		expect(
			canTransitionWorkspace("running", "cancelled", "cancel", "operator"),
		).toBe(false);
		expect(
			canTransitionWorkspace(
				"cancel_requested",
				"cancelled",
				"engine_cancelled",
				"engine",
			),
		).toBe(true);
	});

	test("request changes always returns to an editable stage; a new Gate 1 is required", () => {
		for (const t of into("changes_requested"))
			expect(t.actors).toEqual(["operator"]);
		const out = WORKSPACE_TRANSITIONS.filter(
			(t) => t.from === "changes_requested",
		);
		expect(out.map((t) => [t.to, t.trigger])).toEqual([
			["awaiting_run_approval", "publish_proposal"],
		]);
	});

	test("stage sets agree with the table", () => {
		for (const s of PUBLISHABLE_STAGES)
			expect(
				canTransitionWorkspace(
					s,
					"awaiting_run_approval",
					"publish_proposal",
					"operator",
				),
			).toBe(true);
		for (const s of RERUNNABLE_STAGES)
			expect(
				canTransitionWorkspace(
					s,
					"awaiting_run_approval",
					"request_rerun",
					"operator",
				),
			).toBe(true);
		for (const s of CANCELLABLE_STAGES)
			if (s !== "cancel_requested")
				expect(
					WORKSPACE_TRANSITIONS.some(
						(t) =>
							t.from === s &&
							t.trigger === "cancel" &&
							t.actors.includes("operator"),
					),
				).toBe(true);
		for (const s of stages)
			if (!PUBLISHABLE_STAGES.includes(s))
				expect(
					WORKSPACE_TRANSITIONS.some(
						(t) => t.from === s && t.trigger === "publish_proposal",
					),
				).toBe(false);
	});

	test("every stage is reachable from draft", () => {
		const seen = new Set<WorkspaceStage>(["draft"]);
		let grew = true;
		while (grew) {
			grew = false;
			for (const t of WORKSPACE_TRANSITIONS)
				if (seen.has(t.from) && !seen.has(t.to)) {
					seen.add(t.to);
					grew = true;
				}
		}
		expect([...seen].sort()).toEqual([...stages].sort());
	});

	test("actor matters", () => {
		expect(
			canTransitionWorkspace("queued", "running", "engine_started", "engine"),
		).toBe(true);
		expect(
			canTransitionWorkspace(
				"queued",
				"running",
				"engine_started",
				"reconciler",
			),
		).toBe(true);
		expect(
			canTransitionWorkspace("queued", "running", "engine_started", "operator"),
		).toBe(false);
		expect(
			canTransitionWorkspace(
				"awaiting_run_approval",
				"draft",
				"run_request_invalidated",
				"engine",
			),
		).toBe(false);
		expect(
			canTransitionWorkspace(
				"awaiting_run_approval",
				"draft",
				"run_request_invalidated",
				"reconciler",
			),
		).toBe(true);
	});
});

describe("approval request status", () => {
	const kinds = ApprovalKind.options;
	const statuses = ApprovalStatus.options;
	test("only pending moves, exactly once; finals never move", () => {
		for (const k of kinds)
			for (const from of statuses)
				for (const to of statuses)
					if (from !== "pending")
						expect(canTransitionApproval(k, from, to)).toBe(false);
	});
	test("run requests are approved, result requests accepted — never crosswise", () => {
		expect(canTransitionApproval("run", "pending", "approved")).toBe(true);
		expect(canTransitionApproval("run", "pending", "accepted")).toBe(false);
		expect(canTransitionApproval("result", "pending", "accepted")).toBe(true);
		expect(canTransitionApproval("result", "pending", "approved")).toBe(false);
		expect(canTransitionApproval("run", "pending", "pending")).toBe(false);
	});
	test("decision mapping is consistent with both tables", () => {
		for (const k of kinds)
			for (const a of DecisionAction.options) {
				if (!isActionAllowed(k, a)) continue;
				expect(canTransitionApproval(k, "pending", approvalStatusFor(a))).toBe(
					true,
				);
				const { to, trigger } = stageAfterDecision(k, a);
				expect(
					canTransitionWorkspace(DECISION_STAGE[k], to, trigger, "operator"),
				).toBe(true);
			}
	});
});

describe("engine observations", () => {
	const obs = (
		state: TaskState,
		cancel_requested = false,
		quarantined = false,
	) => ({
		state,
		cancel_requested,
		quarantined,
	});

	test("every transition effect is legal for the engine actor (full matrix)", () => {
		for (const s of stages)
			for (const st of TaskState.options)
				for (const c of [false, true])
					for (const q of [false, true]) {
						const e = engineStageEffect(s, obs(st, c, q));
						if (e.kind === "transition")
							expect(canTransitionWorkspace(s, e.to, e.trigger, "engine")).toBe(
								true,
							);
						if (TERMINAL_WORKSPACE_STAGES.includes(s))
							expect(e.kind).toBe("none");
					}
	});

	test("queued/running follow the engine", () => {
		expect(engineStageEffect("queued", obs("executing"))).toEqual({
			kind: "transition",
			to: "running",
			trigger: "engine_started",
		});
		expect(engineStageEffect("running", obs("reviewing")).kind).toBe("none");
		for (const st of ["blocked", "failed", "interrupted"] as const)
			expect(engineStageEffect("running", obs(st))).toEqual({
				kind: "transition",
				to: "execution_ended",
				trigger: "engine_ended",
			});
		expect(engineStageEffect("running", obs("human_ready")).kind).toBe(
			"seal_result",
		);
		expect(engineStageEffect("queued", obs("human_ready")).kind).toBe(
			"seal_result",
		);
	});

	test("cancel pending is never shown as cancelled before the engine confirms", () => {
		for (const st of [
			"queued",
			"executing",
			"verifying",
			"reviewing",
			"repairing",
		] as const)
			expect(engineStageEffect("cancel_requested", obs(st, true)).kind).toBe(
				"none",
			);
		expect(
			engineStageEffect("cancel_requested", obs("interrupted", true, true))
				.kind,
		).toBe("none");
		expect(
			engineStageEffect("cancel_requested", obs("interrupted", true, false))
				.kind,
		).toBe("reissue_cancel");
		expect(
			engineStageEffect("cancel_requested", obs("cancelled", true)),
		).toEqual({
			kind: "transition",
			to: "cancelled",
			trigger: "engine_cancelled",
		});
		// a result that finished after the cancel intent is withheld (cancel wins)
		expect(
			engineStageEffect("cancel_requested", obs("human_ready", true)),
		).toEqual({
			kind: "transition",
			to: "cancelled",
			trigger: "cancel_won",
		});
	});

	test("a reserved task that runs without Gate 1 is a violation", () => {
		expect(engineStageEffect("awaiting_run_approval", obs("draft")).kind).toBe(
			"none",
		);
		for (const st of ["queued", "executing", "human_ready"] as const)
			expect(engineStageEffect("awaiting_run_approval", obs(st)).kind).toBe(
				"violation",
			);
		expect(engineStageEffect("queued", obs("draft")).kind).toBe("violation");
	});

	test("awaiting_acceptance does not react to the engine (human_ready stays awaiting Edward)", () => {
		expect(
			engineStageEffect("awaiting_acceptance", obs("human_ready")).kind,
		).toBe("none");
	});

	test("sealing outcome", () => {
		expect(stageAfterSealing("running", true)).toEqual({
			to: "awaiting_acceptance",
			trigger: "result_ready",
		});
		expect(stageAfterSealing("running", false)).toEqual({
			to: "execution_ended",
			trigger: "result_unavailable",
		});
		expect(stageAfterSealing("cancel_requested", true)).toEqual({
			to: "cancelled",
			trigger: "cancel_won",
		});
		expect(stageAfterSealing("accepted", true)).toBeNull();
		for (const s of ["queued", "running", "cancel_requested"] as const)
			for (const ok of [true, false]) {
				const r = stageAfterSealing(s, ok);
				if (r)
					expect(canTransitionWorkspace(s, r.to, r.trigger, "engine")).toBe(
						true,
					);
			}
	});
});

describe("derived phase", () => {
	test("engine detail is derived, not stored", () => {
		expect(deriveWorkspacePhase("draft", null)).toBe("planning");
		expect(deriveWorkspacePhase("running", "executing")).toBe("implementing");
		expect(deriveWorkspacePhase("running", "repairing")).toBe("repairing");
		expect(deriveWorkspacePhase("running", "human_ready")).toBe("finalizing");
		expect(deriveWorkspacePhase("running", null)).toBe("queued");
		expect(deriveWorkspacePhase("execution_ended", "blocked")).toBe("blocked");
		expect(deriveWorkspacePhase("execution_ended", "interrupted")).toBe(
			"interrupted",
		);
		expect(deriveWorkspacePhase("execution_ended", "human_ready")).toBe(
			"failed",
		);
		expect(deriveWorkspacePhase("awaiting_acceptance", "human_ready")).toBe(
			"awaiting_acceptance",
		);
		expect(deriveWorkspacePhase("cancel_requested", "executing")).toBe(
			"cancel_requested",
		);
	});
});
