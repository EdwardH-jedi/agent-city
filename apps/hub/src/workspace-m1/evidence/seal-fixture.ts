// Test-only: a REAL human_ready attempt produced by the existing Orchestrator with the fake adapters
// on a disposable fixture repo (managed/testkit.ts), plus the workspace-side inputs a bridge would
// pass to seal(), and helpers that tamper with files/rows or forge a coherent new candidate. All
// content is synthetic; everything lives under the fixture's mkdtemp directory.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ManagedArtifact,
	ManagedRun,
	ManagedTask,
} from "@agent-city/schema";
import {
	type AnyProposalSnapshot,
	type AnyResultEnvelope,
	type ApprovalRequestRow,
	buildProposalSnapshot,
	type ManagedDecisionRow,
	type ManagedProposalRow,
	type SealInput,
} from "@agent-city/schema/workspace-m1";
import {
	buildProposalSnapshotV1_2,
	sealAnyProposal,
	sealExecutionBinding,
} from "@agent-city/schema/workspace-m1/hash";
import { buildManifest } from "../../managed/evidence.ts";
import { Orchestrator } from "../../managed/orchestrator.ts";
import {
	type ManagedDeps,
	runTask,
	submitTask,
} from "../../managed/service.ts";
import { getRun, getTask, listArtifacts } from "../../managed/store.ts";
import {
	type Fixture,
	type FixtureOptions,
	fixtureGit,
	GIT,
	makeFixture,
} from "../../managed/testkit.ts";
import { createAdapters } from "../../managed/worker.ts";
import { loadDiffContexts } from "./context-loader.ts";
import { listDiffFiles } from "./diff-parse.ts";
import { type DisclosureResult, decideDiffDisclosure } from "./disclosure.ts";
import { runnerFor } from "./git-fixture.ts";
import type { RevalidationReads } from "./sealer.ts";

export const IDS = {
	wst: "wst-11111111-1111-4111-8111-111111111111",
	wsp: "wsp-22222222-2222-4222-8222-222222222221",
	runRequest: "wsa-33333333-3333-4333-8333-333333333331",
	resultRequest: "wsa-33333333-3333-4333-8333-333333333332",
	wsd: "wsd-44444444-4444-4444-8444-444444444441",
} as const;
export const POLICY = "e5".repeat(32);

export interface Harness {
	fx: Fixture;
	task: ManagedTask;
	run: ManagedRun;
	proposal: AnyProposalSnapshot;
	input: SealInput;
	reads: RevalidationReads;
	/** A result approval request row bound to `envelope` (what 02 would have stored). */
	requestFor(envelope: AnyResultEnvelope, hash: string): ApprovalRequestRow;
	row(name: string): ManagedArtifact;
	path(name: string): string;
	/** Overwrite an artifact's file (row untouched). */
	writeFile(name: string, content: string | Uint8Array): void;
	/** Overwrite file AND row (sha256, byte_len) coherently. */
	rewrite(name: string, content: string | Uint8Array): void;
	sql(statement: string, ...params: (string | number | null)[]): void;
	/** Rebuild the manifest (file + row + run.manifest_hash), optionally also the review rows/output. */
	remanifest(
		edit: (m: Record<string, unknown>) => void,
		o?: { reviews?: boolean },
	): string;
	/**
	 * Commit `files` in the candidate worktree and rewrite the whole evidence unit coherently for the
	 * new candidate, storing `stored(raw, disclosure)` as diff.patch.
	 */
	recandidate(
		files: Record<string, string | Uint8Array>,
		stored: (raw: string, d: DisclosureResult) => string,
	): Promise<{ raw: string; disclosure: DisclosureResult }>;
}

const fixtures: Fixture[] = [];
export function cleanupSealFixtures() {
	for (const f of fixtures.splice(0)) f.cleanup();
}

const sha256 = (b: string | Uint8Array) =>
	new Bun.CryptoHasher("sha256").update(b).digest("hex");

function gitDiff(cwd: string, a: string, b: string): string {
	const r = Bun.spawnSync(
		[
			GIT,
			"-c",
			"core.hooksPath=/dev/null",
			"diff",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			a,
			b,
		],
		{
			cwd,
			env: {
				PATH: "/usr/bin:/bin",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
			},
		},
	);
	if (r.exitCode !== 0) throw new Error("fixture git diff failed");
	return r.stdout.toString();
}

let keySeq = 0;

/** Drive one simulated task to human_ready and build the seal inputs for it. */
export async function humanReadyRun(
	o: {
		base?: Record<string, string>;
		fixture?: FixtureOptions;
		/** A legacy v1 proposal (no criterion coverage) instead of the v1.2 default. */
		legacy?: boolean;
	} = {},
): Promise<Harness> {
	const fx = makeFixture(o.fixture);
	fixtures.push(fx);
	if (o.base) {
		for (const [p, c] of Object.entries(o.base)) {
			const abs = join(fx.repoPath, p);
			Bun.spawnSync(["mkdir", "-p", join(abs, "..")]);
			writeFileSync(abs, c);
		}
		fixtureGit(fx.repoPath, "add", "-A");
		fixtureGit(fx.repoPath, "commit", "--quiet", "-m", "extra base");
	}
	const deps: ManagedDeps = { db: fx.db, config: fx.config };
	const orch = new Orchestrator({
		db: fx.db,
		config: fx.config,
		adapters: createAdapters(fx.config),
		heartbeatMs: 50,
	});
	const { task: created } = await submitTask(deps, {
		idempotency_key: `seal-key-${++keySeq}`,
		repo_id: fx.repoId,
		title: "Add a simulated change",
		objective: "Exercise the managed pipeline on the fixture repository.",
		acceptance_criteria: ["The fixture check passes"],
		approved_scope: ["."],
		execution_mode: "simulated",
		simulation_scenario: "approve",
		repair_limit: 0,
	});
	runTask(deps, created.id);
	while (await orch.tick()) {
		// drain
	}
	const task = getTask(fx.db, created.id) as ManagedTask;
	if (task.state !== "human_ready" || !task.result_run_id)
		throw new Error(`fixture run did not reach human_ready: ${task.state}`);
	const run = getRun(fx.db, task.result_run_id) as ManagedRun;

	const proposalInput = {
		proposal_id: IDS.wsp,
		workspace_task_id: IDS.wst,
		version: 1,
		predecessor_proposal_id: null,
		repo_id: fx.repoId,
		base_ref: "main",
		base_sha: task.base_sha,
		required_checks: ["fixture-check"],
		draft: {
			title: "Add a simulated change",
			objective: "Exercise the managed pipeline on the fixture repository.",
			criteria: ["The fixture check passes"],
			scope: { allowed: ["."], protected: [] },
			execution_mode: "simulated" as const,
			simulation_scenario: "approve" as const,
			repair_policy: { max_repairs: 0 as const },
			// v1.2 (explicit): the criterion is covered by the fixture repo's trusted check
			criterion_checks: [
				{ criterion: "The fixture check passes", checks: ["fixture-check"] },
			],
		},
	};
	const built = o.legacy
		? buildProposalSnapshot(proposalInput)
		: buildProposalSnapshotV1_2(proposalInput);
	if (!built.ok) throw new Error(JSON.stringify(built.issues));
	const proposal: AnyProposalSnapshot = built.snapshot;
	const proposalHash = sealAnyProposal(proposal).hash;
	const binding = sealExecutionBinding({
		proposal_id: IDS.wsp,
		proposal_hash: proposalHash,
		managed_task_id: task.id,
		base_sha: task.base_sha,
		policy_hash: POLICY,
	});
	const input: SealInput = {
		workspace_task_id: IDS.wst,
		proposal,
		proposal_hash: proposalHash,
		execution_binding: binding.value,
		execution_binding_hash: binding.hash,
		run_decision_id: IDS.wsd,
		managed_task_id: task.id,
		run_id: run.id,
	};
	const reads: RevalidationReads = {
		getProposal: (id) =>
			id === IDS.wsp
				? ({
						id: IDS.wsp,
						workspace_task_id: IDS.wst,
						version: 1,
						predecessor_proposal_id: null,
						snapshot: proposal,
						proposal_hash: proposalHash,
					} as unknown as ManagedProposalRow)
				: null,
		getDecision: (id) =>
			id === IDS.wsd
				? ({
						id: IDS.wsd,
						approval_request_id: IDS.runRequest,
						workspace_task_id: IDS.wst,
						kind: "run",
						action: "approve",
						managed_task_id: task.id,
					} as unknown as ManagedDecisionRow)
				: null,
		getApprovalRequest: (id) =>
			id === IDS.runRequest
				? ({
						id: IDS.runRequest,
						workspace_task_id: IDS.wst,
						kind: "run",
						status: "approved",
						proposal_id: IDS.wsp,
						proposal_hash: proposalHash,
						managed_task_id: task.id,
						execution_binding: binding.value,
						execution_binding_hash: binding.hash,
					} as unknown as ApprovalRequestRow)
				: null,
	};

	const root = fx.config.artifacts_root;
	const row = (name: string) => {
		const a = listArtifacts(fx.db, task.id).find(
			(x) => x.run_id === run.id && x.name === name,
		);
		if (!a) throw new Error(`no artifact ${name}`);
		return a;
	};
	const path = (name: string) => join(root, row(name).rel_path);
	const sql = (statement: string, ...params: (string | number | null)[]) => {
		fx.db.query(statement).run(...params);
	};
	const rewrite = (name: string, content: string | Uint8Array) => {
		const bytes =
			typeof content === "string" ? Buffer.from(content, "utf8") : content;
		writeFileSync(path(name), bytes);
		sql(
			"UPDATE managed_artifacts SET sha256 = ?, byte_len = ? WHERE id = ?",
			sha256(bytes),
			bytes.length,
			row(name).id,
		);
	};
	const currentRun = () => getRun(fx.db, run.id) as ManagedRun;
	const remanifest = (
		edit: (m: Record<string, unknown>) => void,
		opts: { reviews?: boolean } = {},
	) => {
		const { contract: _c, ...m } = JSON.parse(
			readFileSync(path("manifest.json"), "utf8"),
		) as Record<string, unknown>;
		edit(m);
		const built = buildManifest(m as Parameters<typeof buildManifest>[0]);
		rewrite("manifest.json", built.json);
		sql(
			"UPDATE managed_runs SET manifest_hash = ? WHERE id = ?",
			built.hash,
			run.id,
		);
		if (opts.reviews) {
			const cand = currentRun().candidate_sha as string;
			sql(
				"UPDATE managed_reviews SET manifest_hash = ?, candidate_sha = ? WHERE run_id = ?",
				built.hash,
				cand,
				run.id,
			);
			const out = JSON.parse(
				readFileSync(path("review-output.json"), "utf8"),
			) as Record<string, unknown>;
			out.manifest_hash = built.hash;
			out.audited_sha = cand;
			rewrite("review-output.json", JSON.stringify(out, null, 2));
		}
		return built.hash;
	};
	const recandidate = async (
		files: Record<string, string | Uint8Array>,
		stored: (raw: string, d: DisclosureResult) => string,
	) => {
		const wt = currentRun().workspace_path as string;
		for (const [p, c] of Object.entries(files)) {
			Bun.spawnSync(["mkdir", "-p", join(wt, p, "..")]);
			writeFileSync(join(wt, p), c);
		}
		fixtureGit(wt, "add", "-A");
		fixtureGit(wt, "commit", "--quiet", "-m", "recandidate");
		const cand = fixtureGit(wt, "rev-parse", "HEAD");
		const tree = fixtureGit(wt, "rev-parse", "HEAD^{tree}");
		const raw = gitDiff(fx.repoPath, task.base_sha, cand);
		const contexts = await loadDiffContexts(
			runnerFor(fx.repoPath),
			listDiffFiles(raw),
			{ old_rev: task.base_sha, new_rev: cand },
		);
		const disclosure = decideDiffDisclosure({ diff: raw, contexts });
		const diffText = stored(raw, disclosure);
		rewrite("diff.patch", diffText);
		sql(
			"UPDATE managed_artifacts SET candidate_sha = ? WHERE run_id = ?",
			cand,
			run.id,
		);
		sql("UPDATE managed_runs SET candidate_sha = ? WHERE id = ?", cand, run.id);
		remanifest(
			(m) => {
				m.candidate_sha = cand;
				m.candidate_tree = tree;
				m.diff_sha256 = sha256(diffText);
				m.diff_truncated = false;
			},
			{ reviews: true },
		);
		return { raw, disclosure };
	};
	const requestFor = (
		envelope: AnyResultEnvelope,
		hash: string,
	): ApprovalRequestRow =>
		({
			id: IDS.resultRequest,
			workspace_task_id: IDS.wst,
			kind: "result",
			proposal_id: IDS.wsp,
			proposal_hash: proposalHash,
			managed_task_id: task.id,
			execution_binding: binding.value,
			execution_binding_hash: binding.hash,
			run_id: run.id,
			result_envelope: envelope,
			result_envelope_hash: hash,
			status: "pending",
		}) as unknown as ApprovalRequestRow;
	return {
		fx,
		task,
		run,
		proposal,
		input,
		reads,
		requestFor,
		row,
		path,
		writeFile: (name, content) => writeFileSync(path(name), content),
		rewrite,
		sql,
		remanifest,
		recandidate,
	};
}
