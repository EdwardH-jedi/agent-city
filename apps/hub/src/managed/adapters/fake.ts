// Deterministic fake adapters (execution_mode `simulated`). They perform controlled actions on the
// worktree according to the task's simulation_scenario and never call a model. Everything they
// produce is recorded as provider `fake`, mode `simulated`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type Finding,
	IMPLEMENTATION_CONTRACT,
	REVIEW_CONTRACT,
	type SimulationScenario,
} from "@agent-city/schema";
import { childEnv } from "../proc.ts";
import {
	type AdapterContext,
	EMPTY_META,
	type ImplementationAdapter,
	type ImplementInput,
	type ImplementResult,
	type Preflight,
	type ReviewAdapter,
	type ReviewInput,
	type ReviewResult,
} from "./types.ts";

const OK: Preflight = { ok: true, detail: "simulated adapter (no model)" };

const scenarioOf = (s: SimulationScenario | null): SimulationScenario =>
	s ?? "approve";

function write(worktree: string, rel: string, content: string): void {
	const abs = join(worktree, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
}

/** Directory (relative) the fake implementer writes into: the first approved scope prefix. */
const scopeDir = (scope: readonly string[]) =>
	scope[0] === undefined || scope[0] === "." ? "" : scope[0];

export const SIM_DIR = "agentcity-sim";
export const SIM_STATUS_FILE = `${SIM_DIR}/verify.status`;

export const fakeImplementer: ImplementationAdapter = {
	provider: "fake",
	mode: "simulated",
	model_requested: null,
	preflight: async () => OK,
	async implement(
		{ task, run, worktree }: ImplementInput,
		ctx: AdapterContext,
	): Promise<ImplementResult> {
		const scenario = scenarioOf(task.simulation_scenario);
		const meta = { ...EMPTY_META, session_ref: `sim-${run.id}` };
		const log = [
			`simulated implementer: scenario=${scenario} attempt=${run.attempt_no} kind=${run.kind}`,
		];

		if (scenario === "impl_hangs") {
			// A real child in an owned process group, so cancellation is exercised end to end.
			const r = await ctx.run({
				argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
				cwd: worktree,
				env: childEnv(),
				timeoutMs: 3_600_000,
			});
			return {
				...meta,
				ok: false,
				kind: r.aborted
					? "cancelled"
					: r.timedOut
						? "timeout"
						: "provider_error",
				detail: "simulated implementer did not finish",
				log: log.join("\n"),
			};
		}

		if (scenario !== "no_changes") {
			const dir = scopeDir(task.approved_scope);
			const repaired = run.kind === "repair";
			const pass =
				scenario === "verification_fails"
					? false
					: scenario === "verification_fails_then_fixed"
						? repaired
						: true;
			const addressed = (run.repair_input ?? [])
				.map((f) => `- ${f.title}`)
				.join("\n");
			write(
				worktree,
				join(dir, SIM_DIR, `attempt-${run.attempt_no}.md`),
				`# Simulated change\n\nscenario: ${scenario}\nattempt: ${run.attempt_no}\n${
					repaired ? `\naddressed findings:\n${addressed}\n` : ""
				}`,
			);
			write(worktree, join(dir, SIM_STATUS_FILE), pass ? "pass\n" : "fail\n");
			log.push(
				`wrote ${join(dir, SIM_DIR)}/ (verify.status=${pass ? "pass" : "fail"})`,
			);
			if (scenario === "out_of_scope") {
				write(
					worktree,
					"agentcity-out-of-scope.txt",
					"outside the approved scope\n",
				);
				log.push("wrote agentcity-out-of-scope.txt");
			}
		}

		return {
			...meta,
			ok: true,
			log: log.join("\n"),
			output: {
				contract: IMPLEMENTATION_CONTRACT,
				status: "completed",
				summary: `Simulated implementation (${scenario}, attempt ${run.attempt_no}). No model was called.`,
			},
		};
	},
};

const REJECTION: Finding = {
	severity: "major",
	title: "Simulated defect in the change",
	detail:
		"The simulated reviewer rejects this candidate so the repair loop can be exercised.",
	file: null,
	line: null,
	actionable: true,
};

export const fakeReviewer: ReviewAdapter = {
	provider: "fake",
	mode: "simulated",
	model_requested: null,
	preflight: async () => OK,
	async review(input: ReviewInput): Promise<ReviewResult> {
		const { task, run, worktree, candidate_sha, manifest_hash } = input;
		const scenario = scenarioOf(task.simulation_scenario);
		const meta = {
			...EMPTY_META,
			session_ref: `sim-review-${run.id}`,
			log: `simulated reviewer: scenario=${scenario} attempt=${run.attempt_no}`,
		};
		const verdict = (approve: boolean, sha = candidate_sha) => ({
			contract: REVIEW_CONTRACT,
			audited_sha: sha,
			manifest_hash,
			verdict: approve ? "approve" : "reject",
			findings: approve ? [] : [REJECTION],
			tests_executed: false,
			summary: approve
				? "Simulated approval. No model reviewed this change."
				: "Simulated rejection. No model reviewed this change.",
		});

		switch (scenario) {
			case "reviewer_error":
				return {
					...meta,
					ok: false,
					kind: "provider_error",
					detail: "simulated reviewer exited with an error",
				};
			case "malformed_review":
				return { ...meta, ok: true, raw: { verdict: "approve", note: "lgtm" } };
			case "review_wrong_candidate":
				return { ...meta, ok: true, raw: verdict(true, task.base_sha) };
			case "reviewer_mutates":
				write(worktree, "agentcity-reviewer-was-here.txt", "mutated\n");
				return { ...meta, ok: true, raw: verdict(true) };
			case "reject_always":
				return { ...meta, ok: true, raw: verdict(false) };
			case "reject_then_approve":
				return { ...meta, ok: true, raw: verdict(run.kind === "repair") };
			default:
				return { ...meta, ok: true, raw: verdict(true) };
		}
	},
};
