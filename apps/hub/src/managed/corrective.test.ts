// v0.1.1 corrective patch: regressions for five independently reported defects. Everything runs
// against generated stub executables, disposable fixture repos/DBs and synthetic canaries; no real
// provider binary, login or model is involved.
//   C1 an unresolved preflight child stops every later launch (launch boundary + preflight checks)
//   C2 lost or malformed protocol events never permit success
//   C3 unified-diff line prefixes do not defeat multiline secret redaction
//   C4 FIFO evidence / scratch files cannot freeze the hub (probed in separate processes)
//   C5 the artifact API serves only evidence that matches the review-bound manifest
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHub } from "../index.ts";
import { checkCapabilities, checkExecutable } from "./adapters/cli.ts";
import type {
	AdapterContext,
	AdapterSet,
	ImplementationAdapter,
} from "./adapters/types.ts";
import { EMPTY_META } from "./adapters/types.ts";
import { readArtifactBytes, redactDiff } from "./evidence.ts";
import { diffText } from "./git.ts";
import { Orchestrator } from "./orchestrator.ts";
import type { RunResult } from "./proc.ts";
import {
	gitCtx,
	type ManagedDeps,
	runTask,
	ServiceError,
	submitTask,
	taskDetail,
} from "./service.ts";
import { getTask, listArtifacts, listQuarantine } from "./store.ts";
import {
	type Fixture,
	type FixtureOptions,
	fixtureGit,
	makeFixture,
	setStubMode,
	stubCalls,
	stubDir,
	stubPids,
} from "./testkit.ts";
import { createAdapters } from "./worker.ts";

let fixtures: Fixture[] = [];
const strays: number[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
	for (const stop of stops.splice(0))
		try {
			stop();
		} catch {
			// already stopped
		}
	for (const pid of strays.splice(0))
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone
		}
	for (const f of fixtures) f.cleanup();
	fixtures = [];
});

function live(opts: FixtureOptions = {}) {
	const fx = makeFixture({ liveStubs: {}, ...opts });
	fixtures.push(fx);
	return fx;
}

let seq = 0;
async function submitAndRun(
	fx: Fixture,
	adapters: AdapterSet = createAdapters(fx.config),
) {
	const deps: ManagedDeps = { db: fx.db, config: fx.config };
	const { task } = await submitTask(deps, {
		idempotency_key: `corr-${++seq}-${Date.now()}`,
		repo_id: fx.repoId,
		title: "Corrective task",
		objective: "Corrective patch regression.",
		acceptance_criteria: ["The fixture check passes"],
		approved_scope: ["."],
		execution_mode: fx.config.live.enabled ? "live" : "simulated",
	});
	runTask(deps, task.id);
	const orch = new Orchestrator({
		db: fx.db,
		config: fx.config,
		adapters,
		heartbeatMs: 40,
	});
	while (await orch.tick()) {
		// drain
	}
	return { deps, id: task.id, orch, adapters };
}

/** A settled RunResult for unit checks of the preflight predicates. */
const result = (over: Partial<RunResult>): RunResult => ({
	spawned: true,
	spawnError: null,
	pid: 4242,
	exitCode: 0,
	signal: null,
	timedOut: false,
	aborted: false,
	stdout: "1.0.0\n",
	stderr: "",
	stdoutTruncated: false,
	stderrTruncated: false,
	lineOverflow: false,
	durationMs: 1,
	terminationConfirmed: true,
	unresolved: null,
	unresolvedKind: null,
	pipesClosed: Promise.resolve(),
	...over,
});

const fakeCtx = (r: RunResult, scratchDir: string): AdapterContext => ({
	signal: new AbortController().signal,
	scratchDir,
	maxLogBytes: 4096,
	run: async () => r,
});

// ── C1 ──────────────────────────────────────────────────────────────────────

describe("C1 an unresolved preflight child stops every later provider launch", () => {
	const stages = ["version", "help", "auth"] as const;
	for (const provider of ["claude", "codex"] as const)
		for (const [i, stage] of stages.entries())
			test(`${provider} ${stage} check leaves an escaped descendant → quarantine, zero later launches`, async () => {
				const fx = live();
				setStubMode(fx, provider, `escape_${stage}`);
				const run = await submitAndRun(fx);
				const pids = stubPids(fx, provider);
				if (pids) strays.push(pids[1]);
				expect(pids).not.toBeNull();

				const counts = () => ({
					claude: stubCalls(fx, "claude").length,
					codex: stubCalls(fx, "codex").length,
				});
				// the escaping check is the last thing that provider was ever asked to do; for codex
				// the implementer before it ran normally (version, help, auth, one prompt)
				expect(counts()).toEqual(
					provider === "claude"
						? { claude: i + 1, codex: 0 }
						: { claude: 4, codex: i + 1 },
				);
				const t = getTask(fx.db, run.id);
				expect(t?.state).toBe("interrupted");
				const q = listQuarantine(fx.db, { open: true, taskId: run.id });
				expect(q).toHaveLength(1);
				expect(q[0]?.reason).toContain("[pipe]");

				// retry paths: Run is refused while quarantined; later ticks (this worker and a fresh
				// one) launch nothing
				let refused: unknown = null;
				try {
					runTask(run.deps, run.id);
				} catch (err) {
					refused = err;
				}
				expect(refused).toBeInstanceOf(ServiceError);
				expect((refused as ServiceError).code).toBe("process_quarantined");
				const before = counts();
				await run.orch.tick();
				await new Orchestrator({
					db: fx.db,
					config: fx.config,
					adapters: createAdapters(fx.config),
				}).tick();
				expect(counts()).toEqual(before);
			}, 30_000);

	test("the launch boundary itself refuses every launch after an unresolved child (adapter ignores results)", async () => {
		const fx = makeFixture();
		fixtures.push(fx);
		const marker = (n: string) => join(fx.dir, `launched-${n}`);
		const refusals: (string | null)[] = [];
		let implementCalled = false;
		const escapeScript = `const { spawn } = require("node:child_process");
			const c = spawn("/bin/sleep", ["600"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
			c.unref(); console.log(String(c.pid));`;
		const base = createAdapters(fx.config);
		const implementer: ImplementationAdapter = {
			provider: "fake",
			mode: "simulated",
			model_requested: null,
			// a careless adapter: launches, ignores the unresolved result, launches again
			async preflight(ctx) {
				const r = await ctx.run({
					argv: [process.execPath, "-e", escapeScript],
					cwd: fx.dir,
					env: { PATH: "/usr/bin:/bin" },
					timeoutMs: 10_000,
				});
				const pid = Number(r.stdout.trim());
				if (pid) strays.push(pid);
				const again = await ctx.run({
					argv: ["/usr/bin/touch", marker("preflight")],
					cwd: fx.dir,
					env: { PATH: "/usr/bin:/bin" },
					timeoutMs: 10_000,
				});
				refusals.push(again.spawned ? null : again.spawnError);
				return { ok: true, detail: "ignores every result" };
			},
			async implement(_input, ctx) {
				implementCalled = true;
				await ctx.run({
					argv: ["/usr/bin/touch", marker("implement")],
					cwd: fx.dir,
					env: { PATH: "/usr/bin:/bin" },
					timeoutMs: 10_000,
				});
				return {
					...EMPTY_META,
					ok: false,
					kind: "provider_error",
					detail: "x",
				};
			},
		};
		const adapters: AdapterSet = {
			implementer: () => implementer,
			reviewer: (m) => base.reviewer(m),
		};
		const run = await submitAndRun(fx, adapters);
		expect(existsSync(marker("preflight"))).toBe(false);
		expect(existsSync(marker("implement"))).toBe(false);
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toContain("quarantine");
		expect(implementCalled).toBe(false);
		expect(getTask(fx.db, run.id)?.state).toBe("interrupted");
	}, 30_000);

	test("exit code 0 never overrides an unresolved child in --version / --help checks", async () => {
		const fx = makeFixture();
		fixtures.push(fx);
		const exe = process.execPath;
		for (const bad of [
			{
				unresolved: "the output pipes stayed open",
				unresolvedKind: "pipe" as const,
				terminationConfirmed: false,
			},
			{ terminationConfirmed: false },
			{ aborted: true },
		]) {
			const r = result(bad);
			expect((await checkExecutable(fakeCtx(r, fx.dir), exe, fx.dir)).ok).toBe(
				false,
			);
			expect(
				(
					await checkCapabilities(
						fakeCtx({ ...r, stdout: "  --json\n" }, fx.dir),
						[exe, "--help"],
						["--json"],
						fx.dir,
					)
				).ok,
			).toBe(false);
		}
		// control: a clean result still passes
		expect(
			(await checkExecutable(fakeCtx(result({}), fx.dir), exe, fx.dir)).ok,
		).toBe(true);
	});
});

// ── C2 ──────────────────────────────────────────────────────────────────────

describe("C2 lost or malformed protocol events never permit success", () => {
	const reviewLaunched = (fx: Fixture) =>
		stubCalls(fx, "codex").some(
			(c) => c.argv[0] === "exec" && c.argv.includes("--json"),
		);

	for (const mode of [
		"oversized_then_success",
		"oversized_error_then_success",
		"malformed_then_success",
	])
		test(`claude ${mode} → provider_output_invalid; nothing downstream starts`, async () => {
			const fx = live();
			setStubMode(fx, "claude", mode);
			const run = await submitAndRun(fx);
			const d = await taskDetail(run.deps, run.id);
			expect(d.task.state).not.toBe("human_ready");
			expect(d.task.failure_kind).toBe("provider_output_invalid");
			expect(d.runs[0]?.candidate_sha).toBeNull();
			expect(d.reviews).toHaveLength(0);
			expect(reviewLaunched(fx)).toBe(false);
		}, 30_000);

	for (const mode of ["oversized_failure", "malformed_then_approve"])
		test(`codex ${mode} then a valid approval + exit 0 → no valid review, never human_ready`, async () => {
			const fx = live();
			setStubMode(fx, "codex", mode);
			const run = await submitAndRun(fx);
			const d = await taskDetail(run.deps, run.id);
			expect(reviewLaunched(fx)).toBe(true);
			expect(d.task.state).not.toBe("human_ready");
			expect(d.task.result_run_id).toBeNull();
			expect(d.task.failure_kind).toBe("provider_output_invalid");
			expect(d.reviews.filter((r) => r.valid)).toHaveLength(0);
			expect(d.reviews.some((r) => r.verdict === "approve")).toBe(false);
		}, 30_000);

	test("controls: unknown event types, stderr diagnostics and capped capture still succeed", async () => {
		// default stubs: a split line, stderr noise, an unknown event type, reasoning items
		const fx = live();
		const ok = await submitAndRun(fx);
		expect(getTask(fx.db, ok.id)?.state).toBe("human_ready");
		// ~1.2 MB of valid events with a 4 KiB capture cap: diagnostic truncation, not event loss
		const big = live({ limits: { max_log_bytes: 4096 } });
		setStubMode(big, "claude", "big");
		const bigRun = await submitAndRun(big);
		expect(getTask(big.db, bigRun.id)?.state).toBe("human_ready");
	}, 30_000);
});

// ── shared: an in-process hub for API assertions ────────────────────────────

const TOKEN = `corrective-managed-${"t".repeat(24)}`;
const INGEST = `corrective-ingest-${"i".repeat(24)}`;

function hubFor(fx: Fixture) {
	const h = startHub({
		db: fx.db,
		ingestToken: INGEST,
		hostname: "127.0.0.1",
		port: 0,
		managed: { config: fx.config, token: TOKEN },
		managedIdleMs: 50,
	});
	stops.push(() => h.stop());
	const base = `http://127.0.0.1:${h.server.port}`;
	return async (path: string) => {
		const res = await fetch(`${base}/api/managed${path}`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		return { status: res.status, body: await res.text() };
	};
}

// ── C3 ──────────────────────────────────────────────────────────────────────

/** Synthetic canaries, assembled at runtime — never real secrets. */
const PK = ["PRIVATE", "KEY"].join(" "); // keeps literal key markers out of the source
const gh = (body: string) => `${"gh"}p_${body}`;
const C3 = (() => {
	const shared = gh("SHARED1234A"); // 11 chars after the prefix: not a token on its own
	const restOld = `OLD${"Zz09".repeat(7)}`;
	const restNew = `NEW${"Yy18".repeat(7)}`;
	const addedHead = gh("ADD12345");
	const addedRest = `ADD${"Xx27".repeat(7)}`;
	return {
		yamlOld: "YAMLCANARY-OLD-4821",
		yamlNew: "YAMLCANARY-NEW-7305",
		yamlAdded: "YAMLCANARY-ADDED-9162",
		keyBody: "KEYCANARY-BODY-5530",
		shared,
		restOld,
		restNew,
		addedHead,
		addedRest,
	};
})();
const C3_CANARIES = [
	C3.yamlOld,
	C3.yamlNew,
	C3.yamlAdded,
	C3.keyBody,
	C3.shared,
	C3.restOld,
	C3.restNew,
	C3.shared + C3.restOld,
	C3.shared + C3.restNew,
	C3.addedHead,
	C3.addedRest,
	C3.addedHead + C3.addedRest,
];
const C3_KEPT = [
	"next_key: visible",
	"after_key: visible-too",
	"echo done",
	"plain_after: kept",
	"diff --git a/config/app.yaml b/config/app.yaml",
];

const yamlFile = (block: string, extra = "") =>
	`name: demo\nclient_secret: |\n  ${block}\n  second line of the old block\nnext_key: visible\n${extra}`;
const deployFile = (rest: string) =>
	`#!/bin/sh\nexport DEPLOY_TOKEN=${C3.shared}\\\n  ${rest}\necho done\n`;

/** Base commit with the "old" secrets; returns the files the implementer then writes. */
function seedSecrets(repo: string): Record<string, string> {
	mkdirSync(join(repo, "config"), { recursive: true });
	writeFileSync(join(repo, "config", "app.yaml"), yamlFile(C3.yamlOld));
	writeFileSync(join(repo, "deploy.sh"), deployFile(C3.restOld));
	fixtureGit(repo, "add", "-A");
	fixtureGit(repo, "commit", "--quiet", "-m", "fixture secrets");
	return {
		"config/app.yaml": yamlFile(
			C3.yamlNew,
			`api_key: |\n  ${C3.yamlAdded}\n  more of the added block\nafter_key: visible-too\n`,
		),
		"deploy.sh": deployFile(C3.restNew),
		"added.env": [
			`CI_VALUE=${C3.addedHead}\\`,
			`  ${C3.addedRest}`,
			`-----BEGIN OPENSSH ${PK}-----`,
			C3.keyBody,
			`-----END OPENSSH ${PK}-----`,
			"plain_after: kept",
			"",
		].join("\n"),
		"agentcity-sim/verify.status": "pass\n",
	};
}

describe("C3 unified-diff prefixes do not defeat multiline redaction", () => {
	test("end to end: persisted diff bytes, reviewer input and artifact API hold no canary or fragment", async () => {
		const fx = live();
		const payload = seedSecrets(fx.repoPath);
		writeFileSync(
			join(stubDir(fx), "claude.payload.json"),
			JSON.stringify(payload),
		);
		setStubMode(fx, "claude", "write_payload");
		const run = await submitAndRun(fx);
		expect(getTask(fx.db, run.id)?.state).toBe("human_ready");

		const diffArt = listArtifacts(fx.db, run.id).find(
			(a) => a.name === "diff.patch",
		);
		if (!diffArt) throw new Error("no diff artifact");
		const persisted = readArtifactBytes(
			fx.config.artifacts_root,
			diffArt,
		).toString("utf8");
		const reviewerInput = stubCalls(fx, "codex")
			.filter((c) => c.argv[0] === "exec" && c.argv.includes("--json"))
			.map((c) => c.stdin)
			.join("\n");
		expect(reviewerInput).toContain("## Diff (base → candidate)");
		const api = await hubFor(fx)(`/tasks/${run.id}/artifacts/${diffArt.id}`);
		expect(api.status).toBe(200);

		// every leak and every lost line of context, per surface (one assertion lists them all)
		const surfaces = {
			"persisted diff": persisted,
			"reviewer input": reviewerInput,
			"artifact API": api.body,
		};
		const leaks = Object.entries(surfaces).flatMap(([surface, text]) =>
			C3_CANARIES.filter((c) => text.includes(c)).map(
				(c) => `${surface}: ${c}`,
			),
		);
		const lost = Object.entries(surfaces).flatMap(([surface, text]) =>
			C3_KEPT.filter((k) => !text.includes(k)).map((k) => `${surface}: ${k}`),
		);
		expect(leaks).toEqual([]);
		expect(lost).toEqual([]);
	}, 60_000);
});

describe("C3 redactDiff over real git diffs", () => {
	test("added, removed and context lines (incl. a deleted file) keep structure, lose every canary", async () => {
		const fx = makeFixture();
		fixtures.push(fx);
		const repo = fx.repoPath;
		const payload = seedSecrets(repo);
		const removedCanary = "YAMLCANARY-REMOVED-3317";
		writeFileSync(
			join(repo, "removed.yaml"),
			`keep: me\npassword: |\n  ${removedCanary}\n  tail\n`,
		);
		fixtureGit(repo, "add", "-A");
		fixtureGit(repo, "commit", "--quiet", "-m", "more fixture secrets");
		const base = fixtureGit(repo, "rev-parse", "HEAD");
		for (const [rel, content] of Object.entries(payload)) {
			mkdirSync(join(repo, rel, ".."), { recursive: true });
			writeFileSync(join(repo, rel), content);
		}
		fixtureGit(repo, "rm", "--quiet", "removed.yaml");
		fixtureGit(repo, "add", "-A");
		fixtureGit(repo, "commit", "--quiet", "-m", "change");
		const raw = await diffText(
			gitCtx(fx.config),
			repo,
			base,
			"HEAD",
			1_000_000,
		);
		expect(raw.truncated).toBe(false);
		// the raw diff really has the prefixed shapes this is about
		expect(raw.text).toContain(`-  ${C3.yamlOld}`);
		expect(raw.text).toContain(`+  ${C3.yamlNew}`);
		expect(raw.text).toContain(`-  ${removedCanary}`);

		const out = redactDiff(raw.text);
		const leaks = [...C3_CANARIES, removedCanary].filter((c) =>
			out.includes(c),
		);
		expect(leaks).toEqual([]);
		for (const kept of [...C3_KEPT, "-keep: me", "-password: |"])
			expect(out).toContain(kept);
		// changed lines stay changed lines; context stays context
		for (const line of [
			" client_secret: |",
			`-  [REDACTED]`,
			`+  [REDACTED]`,
			"+api_key: |",
			" export DEPLOY_TOKEN=[REDACTED]",
			"+CI_VALUE=[REDACTED]",
		])
			expect(out.split("\n")).toContain(line);
		// every hunk line still carries a valid prefix; headers are untouched
		let inHunk = false;
		for (const line of out.split("\n")) {
			if (line.startsWith("diff --git ")) inHunk = false;
			else if (line.startsWith("@@")) inHunk = true;
			else if (inHunk && line !== "")
				expect(["+", "-", " ", "\\"]).toContain(line[0] as string);
		}
	});

	test("a context line shared by two versions that mask it differently is masked whole", () => {
		const head = gh("CTX1234567"); // too short to be a token alone
		const diff = [
			"diff --git a/x.sh b/x.sh",
			"--- a/x.sh",
			"+++ b/x.sh",
			"@@ -1,2 +1,2 @@",
			` VALUE=${head}\\`,
			`-  ${"Pp45".repeat(8)}`,
			"+  plain words here",
		].join("\n");
		const out = redactDiff(diff);
		expect(out).not.toContain(head);
		expect(out).not.toContain("Pp45Pp45");
		expect(out.split("\n").length).toBe(7);
	});
});
