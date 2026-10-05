// Executor contract: frozen input, validated informational artifact, classified failures, and no way
// for executor output to drive workflow state.
import { describe, expect, test } from "bun:test";
import {
	type SupportArtifactBody,
	validateExecutorOutput,
} from "./artifact.ts";
import {
	buildSupportExecutorInput,
	runSupportJob,
	type SupportExecutor,
	type SupportExecutorInput,
} from "./executor.ts";
import { createFakeSupportExecutor, fakeSupportBody } from "./fake-executor.ts";
import {
	SUPPORT_JOB_KINDS,
	type SupportJob,
	type SupportJobKind,
} from "./job.ts";
import { cancelRequested, DEFAULT_REFS, queued, running } from "./testkit.ts";

/** An executor that returns `output` (or throws it when `throws`). */
function stub(
	output: unknown,
	throws = false,
): SupportExecutor & { seen: SupportExecutorInput[] } {
	const seen: SupportExecutorInput[] = [];
	return {
		executor_id: "stub",
		capabilities: ["fast", "standard"],
		seen,
		async execute(input) {
			seen.push(input);
			if (throws) throw output;
			return output;
		},
	};
}

const handoff = (extra: Record<string, unknown> = {}) => ({
	kind: "HANDOFF",
	title: "Handoff",
	handoff_text: "Where things stand.",
	open_questions: [],
	...extra,
});

async function settleWith(
	output: unknown,
	job = running({ id: "h1", kind: "HANDOFF" }),
) {
	const r = await runSupportJob(job, stub(output));
	if (!r.ok) throw new Error(r.error);
	return r;
}

describe("fake executor end-to-end", () => {
	test.each([...SUPPORT_JOB_KINDS])(
		"%s → COMPLETED with a deterministic artifact",
		async (kind) => {
			const job = running({
				id: `job-${kind.toLowerCase()}`,
				kind,
				inputs: DEFAULT_REFS[kind],
			});
			const fake = createFakeSupportExecutor();
			const a = await runSupportJob(job, fake);
			const b = await runSupportJob(job, fake);
			expect(a.ok && b.ok).toBe(true);
			if (!a.ok || !b.ok) return;
			expect(a.job.status).toBe("COMPLETED");
			expect(a.artifact?.body).toEqual(
				fakeSupportBody(buildSupportExecutorInput(job)),
			);
			expect(a.artifact).toEqual(b.artifact);
			expect(a.artifact?.informational).toBe(true);
			expect(a.job.result).toEqual({
				artifact_id: `${job.id}.artifact`,
				artifact_kind: kind,
				text_chars: a.artifact?.text_chars ?? -1,
			});
			expect(fake.calls).toEqual([job.id, job.id]);
			// The argument job is untouched.
			expect(job.status).toBe("RUNNING");
		},
	);

	test("executor input is a deep-frozen copy without job state", async () => {
		const job = running({
			id: "in1",
			kind: "LOG_TRIAGE",
			brief: "look at retries",
		});
		const ex = stub(handoff());
		await runSupportJob(job, ex);
		const input = ex.seen[0];
		expect(input).toEqual({
			job_id: "in1",
			repo_id: "acme/widgets",
			kind: "LOG_TRIAGE",
			capability: "fast",
			inputs: [{ kind: "log", id: "ci-log-42" }],
			brief: "look at retries",
		});
		expect(Object.isFrozen(input)).toBe(true);
		expect(Object.isFrozen(input?.inputs)).toBe(true);
		expect(Object.isFrozen(input?.inputs[0])).toBe(true);
	});

	test("an executor that tries to mutate its input fails, the job is unchanged", async () => {
		const job = running({ id: "mut", kind: "HANDOFF" });
		const ex: SupportExecutor = {
			executor_id: "mutator",
			capabilities: ["fast"],
			async execute(input) {
				(input as { repo_id: string }).repo_id = "evil/repo";
				return handoff();
			},
		};
		const r = await runSupportJob(job, ex);
		expect(r.ok && r.job.status).toBe("FAILED");
		expect(r.ok && r.job.failure?.classification).toBe("EXECUTOR_ERROR");
		expect(job.repo_id).toBe("acme/widgets");
	});
});

describe("preconditions leave the job untouched", () => {
	test("job must be RUNNING", async () => {
		const ex = stub(handoff());
		expect(await runSupportJob(queued({ id: "x" }), ex)).toEqual({
			ok: false,
			error: "not_running",
		});
		expect(ex.seen).toEqual([]);
	});

	test("executor must serve the job's capability", async () => {
		const ex = createFakeSupportExecutor(["fast"]);
		const job = running({ id: "y", capability: "standard" });
		expect(await runSupportJob(job, ex)).toEqual({
			ok: false,
			error: "capability_unsupported",
		});
		expect(ex.calls).toEqual([]);
	});

	test("a job object carrying extra keys is refused before the executor runs", async () => {
		const ex = stub(handoff());
		const job = {
			...running({ id: "z" }),
			command: "git push",
		} as unknown as SupportJob;
		expect(await runSupportJob(job, ex)).toEqual({
			ok: false,
			error: "invalid_job",
		});
		expect(ex.seen).toEqual([]);
	});
});

describe("11. executor output cannot mutate workflow state", () => {
	const authorityOutputs: [string, SupportJobKind, unknown][] = [
		["command", "HANDOFF", handoff({ command: "git push origin main" })],
		["argv", "HANDOFF", handoff({ argv: ["rm", "-rf", "/"] })],
		["shell", "HANDOFF", handoff({ shell: "bash" })],
		["status override", "HANDOFF", handoff({ status: "COMPLETED" })],
		["managed state", "HANDOFF", handoff({ next_state: "human_ready" })],
		["state", "HANDOFF", handoff({ state: "executing" })],
		["transition", "HANDOFF", handoff({ transition_to: "approved" })],
		["approve", "HANDOFF", handoff({ approve: true })],
		["approval", "HANDOFF", handoff({ approval: { granted: true } })],
		["accept", "HANDOFF", handoff({ accepted: true })],
		["verdict", "HANDOFF", handoff({ verdict: "approve" })],
		["git push", "HANDOFF", handoff({ git_push: { ref: "main" } })],
		["merge", "HANDOFF", handoff({ merge_pr: 12 })],
		["open pr", "HANDOFF", handoff({ open_pr: true })],
		["publish", "HANDOFF", handoff({ publish: true })],
		["deploy", "HANDOFF", handoff({ deploy_target: "prod" })],
		["write path", "HANDOFF", handoff({ write_path: "src/index.ts" })],
		["callback", "HANDOFF", handoff({ on_done_callback: "x" })],
		["webhook", "HANDOFF", handoff({ webhook: "x" })],
		["actions list", "HANDOFF", handoff({ actions: [{ type: "merge" }] })],
		["credential key", "HANDOFF", handoff({ api_token: "x" })],
		[
			"nested in a list item",
			"REVIEW_TO_TODOS",
			{
				kind: "REVIEW_TO_TODOS",
				title: "t",
				todos: [{ text: "a", severity: "minor", run_command: "make" }],
			},
		],
		["nested deep", "HANDOFF", handoff({ meta: { inner: { exec: "x" } } })],
	];

	test.each(authorityOutputs)(
		"output with %s → FAILED FORBIDDEN_AUTHORITY",
		async (_name, kind, output) => {
			const r = await settleWith(output, running({ id: "h2", kind }));
			expect(r.job.status).toBe("FAILED");
			expect(r.job.failure?.classification).toBe("FORBIDDEN_AUTHORITY");
			expect(r.artifact).toBeNull();
		},
	);

	test("the settled result is plain data: exactly ok / job / artifact", async () => {
		const r = await settleWith(handoff());
		expect(Object.keys(r).sort()).toEqual(["artifact", "job", "ok"]);
		expect(Object.isFrozen(r)).toBe(true);
		expect(Object.isFrozen(r.job)).toBe(true);
		expect(Object.isFrozen(r.artifact)).toBe(true);
		expect(Object.isFrozen(r.artifact?.body)).toBe(true);
	});

	test("raw output object identity, prototype and extras never reach the artifact", async () => {
		class Sneaky {
			kind = "HANDOFF";
			title = "Handoff";
			handoff_text = "text";
			open_questions: string[] = [];
			then_do() {
				return "merge";
			}
		}
		const raw = new Sneaky();
		const r = await settleWith(raw);
		expect(r.job.status).toBe("COMPLETED");
		expect(r.artifact?.body).not.toBe(raw as unknown as SupportArtifactBody);
		expect(Object.getPrototypeOf(r.artifact?.body)).toBe(Object.prototype);
		expect("then_do" in (r.artifact?.body ?? {})).toBe(false);
	});

	test("the completed job only gains result metadata", async () => {
		const job = running({ id: "h3", kind: "HANDOFF" });
		const r = await settleWith(handoff(), job);
		const { status: _s, result: _r, ...rest } = r.job;
		const { status: _s0, result: _r0, ...before } = job;
		expect(rest).toEqual(before);
		expect(r.job.status).toBe("COMPLETED");
	});

	const invalidOutputs: [string, unknown][] = [
		["undefined", undefined],
		["null", null],
		["string", "all good, merging now"],
		["number", 42],
		["function", () => "x"],
		["array", [handoff()]],
		["unknown kind", { kind: "IMPLEMENTATION", title: "t", summary: "s" }],
		["missing field", { kind: "HANDOFF", title: "t" }],
		["unknown harmless key", handoff({ mood: "good" })],
		["text too long", handoff({ handoff_text: "x".repeat(20_001) })],
		["empty todos", { kind: "REVIEW_TO_TODOS", title: "t", todos: [] }],
		[
			"too deep",
			handoff({
				a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } },
			}),
		],
	];

	test.each(invalidOutputs)(
		"%s → FAILED INVALID_OUTPUT",
		async (_n, output) => {
			const r = await settleWith(output);
			expect(r.job.status).toBe("FAILED");
			expect(r.job.failure?.classification).toBe("INVALID_OUTPUT");
			expect(r.artifact).toBeNull();
		},
	);

	test("cyclic output → INVALID_OUTPUT (bounded scan)", async () => {
		const cyclic: Record<string, unknown> = handoff();
		cyclic.self = cyclic;
		const r = await settleWith(cyclic);
		expect(r.job.failure?.classification).toBe("INVALID_OUTPUT");
	});

	test("throwing getter / proxy output → INVALID_OUTPUT, never a throw", async () => {
		const trap = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error("boom");
				},
			},
		);
		expect((await settleWith(trap)).job.failure?.classification).toBe(
			"INVALID_OUTPUT",
		);
		const getter = Object.defineProperty(handoff(), "title", {
			enumerable: true,
			get() {
				throw new Error("boom");
			},
		});
		expect((await settleWith(getter)).job.failure?.classification).toBe(
			"INVALID_OUTPUT",
		);
	});

	test("valid body of another kind → KIND_MISMATCH", async () => {
		const r = await settleWith({
			kind: "PR_DRAFT",
			draft_title: "t",
			draft_body: "b",
		});
		expect(r.job.failure?.classification).toBe("KIND_MISMATCH");
	});

	test("credential in artifact text → OUTPUT_SECRET, detail does not echo it", async () => {
		const fake = `sk-ant-${"a".repeat(24)}`;
		const r = await settleWith(handoff({ handoff_text: `use key ${fake}` }));
		expect(r.job.failure?.classification).toBe("OUTPUT_SECRET");
		expect(JSON.stringify(r)).not.toContain(fake);
	});

	test("executor throw → EXECUTOR_ERROR with a redacted, bounded detail", async () => {
		const fake = `gh${"p_"}${"B".repeat(36)}`;
		const err = new Error(`upstream said ${fake} ${"y".repeat(2000)}`);
		const t = await runSupportJob(
			running({ id: "t1", kind: "HANDOFF" }),
			stub(err, true),
		);
		expect(t.ok && t.job.status).toBe("FAILED");
		expect(t.ok && t.job.failure?.classification).toBe("EXECUTOR_ERROR");
		const detail = t.ok ? (t.job.failure?.detail ?? "") : "";
		expect(detail).not.toContain(fake);
		expect(detail.length).toBeLessThanOrEqual(500);
		const n = await runSupportJob(
			running({ id: "t2", kind: "HANDOFF" }),
			stub("plain string", true),
		);
		expect(n.ok && n.job.failure?.classification).toBe("EXECUTOR_ERROR");
	});

	test("validateExecutorOutput is pure: same input, same answer, no job change", () => {
		const job = running({ id: "v1", kind: "HANDOFF" });
		const a = validateExecutorOutput(job, handoff());
		const b = validateExecutorOutput(job, handoff());
		expect(a).toEqual(b);
		expect(job.status).toBe("RUNNING");
		expect(job.result).toBeNull();
	});
});

describe("cancellation", () => {
	test("cancel-requested job settles CANCELLED without calling the executor", async () => {
		const ex = stub(handoff());
		const r = await runSupportJob(
			cancelRequested({ id: "c1", kind: "HANDOFF" }),
			ex,
		);
		expect(r.ok && r.job.status).toBe("CANCELLED");
		expect(r.ok && r.artifact).toBeNull();
		expect(ex.seen).toEqual([]);
	});

	test("abort during execution discards valid output → CANCELLED", async () => {
		const ctl = new AbortController();
		const ex: SupportExecutor = {
			executor_id: "aborting",
			capabilities: ["fast"],
			async execute(_input, ctx) {
				ctl.abort();
				expect(ctx.signal.aborted).toBe(true);
				return handoff();
			},
		};
		const r = await runSupportJob(running({ id: "c2", kind: "HANDOFF" }), ex, {
			signal: ctl.signal,
		});
		expect(r.ok && r.job.status).toBe("CANCELLED");
		expect(r.ok && r.artifact).toBeNull();
	});

	test("abort that makes the executor throw → CANCELLED, not FAILED", async () => {
		const ctl = new AbortController();
		const ex: SupportExecutor = {
			executor_id: "aborting",
			capabilities: ["fast"],
			async execute() {
				ctl.abort();
				throw new Error("aborted");
			},
		};
		const r = await runSupportJob(running({ id: "c3", kind: "HANDOFF" }), ex, {
			signal: ctl.signal,
		});
		expect(r.ok && r.job.status).toBe("CANCELLED");
	});
});
