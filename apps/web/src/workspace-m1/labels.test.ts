// Display derivations (role 07): cancellation requested vs confirmed, and the truthful note while
// the engine is ahead of the stored workspace stage (no acceptance before a result request exists).
import { describe, expect, test } from "bun:test";
import type {
	EngineView,
	WorkspaceTaskDetail,
} from "@agent-city/schema/workspace-m1";
import { cancellationStatus, engineAheadNote } from "./labels.ts";

const AT = "2026-10-02T00:00:00.000Z";
const engine = (state: EngineView["state"], over: Partial<EngineView> = {}) =>
	({
		state,
		cancel_requested_at: null,
		result_run_id: null,
		...over,
	}) as EngineView;
const detail = (
	stage: WorkspaceTaskDetail["task"]["stage"],
	e: EngineView | null,
	requests: unknown[] = [],
) =>
	({
		task: { stage, cancel_requested_at: null },
		engine: e,
		approval_requests: requests,
	}) as unknown as WorkspaceTaskDetail;

describe("cancellation status", () => {
	test("absent without an intent", () => {
		expect(
			cancellationStatus(
				{ stage: "running", cancel_requested_at: null },
				engine("executing"),
			),
		).toBeNull();
		// a reserved task cancelled by a Gate-1 reject is not a cancellation
		expect(
			cancellationStatus(
				{ stage: "rejected", cancel_requested_at: null },
				engine("cancelled"),
			),
		).toBeNull();
	});
	test("requested while the engine still runs", () => {
		expect(
			cancellationStatus(
				{ stage: "cancel_requested", cancel_requested_at: AT },
				engine("executing", { cancel_requested_at: AT }),
			),
		).toBe("requested");
	});
	test("confirmed by the engine's cancelled state or the cancelled stage", () => {
		expect(
			cancellationStatus(
				{ stage: "cancel_requested", cancel_requested_at: AT },
				engine("cancelled", { cancel_requested_at: AT }),
			),
		).toBe("confirmed");
		expect(
			cancellationStatus(
				{ stage: "cancelled", cancel_requested_at: AT },
				engine("cancelled"),
			),
		).toBe("confirmed");
	});
	test("an execution that failed first is not shown as cancelled", () => {
		expect(
			cancellationStatus(
				{ stage: "cancel_requested", cancel_requested_at: AT },
				engine("interrupted", { cancel_requested_at: AT }),
			),
		).toBe("requested");
		expect(
			cancellationStatus(
				{ stage: "execution_ended", cancel_requested_at: AT },
				engine("failed", { cancel_requested_at: AT }),
			),
		).toBeNull();
	});
});

describe("engine ahead of the stored stage", () => {
	test("human_ready without a result request: acceptance not available yet", () => {
		const note = engineAheadNote(
			detail("queued", engine("human_ready", { result_run_id: "run-1" })),
		);
		expect(note).toContain("not open for acceptance");
	});
	test("human_ready with its result request open: no note", () => {
		const d = detail(
			"awaiting_acceptance",
			engine("human_ready", { result_run_id: "run-1" }),
			[{ kind: "result", run_id: "run-1" }],
		);
		expect(engineAheadNote(d)).toBeNull();
		const running = detail(
			"running",
			engine("human_ready", { result_run_id: "run-1" }),
			[{ kind: "result", run_id: "run-1" }],
		);
		expect(engineAheadNote(running)).toBeNull();
	});
	test("active engine while the stage still says queued; ended engine; no engine", () => {
		expect(engineAheadNote(detail("queued", engine("verifying")))).toContain(
			"working",
		);
		expect(engineAheadNote(detail("running", engine("failed")))).toContain(
			"ended",
		);
		expect(engineAheadNote(detail("running", engine("verifying")))).toBeNull();
		expect(engineAheadNote(detail("draft", null))).toBeNull();
	});
});

describe("sealed statuses after revalidation", () => {
	const result = (status: string, reason: string | null) => ({
		kind: "result",
		status,
		invalidation_reason: reason,
		result_envelope: { evidence_status: "verified" },
	});
	test("integrity_failed → neutral unknown, candidate_mutated → stale, never the sealed 'verified'", async () => {
		const { evidenceStatus, evidenceStatusLabel, resultRevocation } =
			await import("./labels.ts");
		const d = (r: unknown) =>
			({ approval_requests: [r] }) as unknown as WorkspaceTaskDetail;
		expect(evidenceStatus(d(result("invalidated", "integrity_failed")))).toBe(
			"unknown",
		);
		expect(
			evidenceStatusLabel(d(result("invalidated", "integrity_failed"))),
		).toBe("Integrity check failed — evidence changed or missing");
		expect(evidenceStatusLabel(d(result("pending", null)))).toBe("Verified");
		expect(evidenceStatus(d(result("invalidated", "candidate_mutated")))).toBe(
			"stale",
		);
		expect(evidenceStatus(d(result("pending", null)))).toBe("verified");
		expect(evidenceStatus(d(result("invalidated", "task_cancelled")))).toBe(
			"verified",
		);
		expect(
			resultRevocation({
				kind: "run",
				status: "invalidated",
				invalidation_reason: "integrity_failed",
			}),
		).toBeNull();
	});
});
