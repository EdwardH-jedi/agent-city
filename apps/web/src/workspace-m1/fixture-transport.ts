// Fixture transport (role 07): the WorkspaceTransport facade over FixtureWorld, plus the fixture
// CONTROLS that tests and the dev harness use to move the simulated engine. Controls are never
// rendered in the product UI; in a fixture build they are reachable only as a global object for
// browser QA (see config.ts). Every answer is parsed with the frozen contract schema before it is
// returned, so a fixture bug surfaces as `invalid_response` instead of silently shaping the UI.
import {
	type AcceptanceValidityReason,
	type AcceptanceValidityStatus,
	ArtifactTextResponse,
	ChallengeIssueResponse,
	DecisionResponse,
	emptyDraft,
	SessionView,
	type WorkspaceDraft,
	WorkspaceSnapshot,
	WorkspaceTaskDetail,
	WorkspaceTaskView,
} from "@agent-city/schema/workspace-m1";
import {
	type DecisionFault,
	type FixtureEvidence,
	FixtureWorld,
	type FixtureWorldOptions,
} from "./fixture-world.ts";
import type { TransportResult, WorkspaceTransport } from "./transport.ts";

export type FixtureRoute =
	| "session"
	| "snapshot"
	| "task"
	| "command"
	| "artifact"
	| "challenge"
	| "decision";

/** Programmatic controls of the fixture (tests / dev harness / browser QA FX set). */
export interface FixtureControls {
	/** One engine step of the task's current execution (scenario-driven). */
	advance(taskId: string, evidence?: FixtureEvidence): boolean;
	/** Step until nothing moves (bounded). */
	runToEnd(taskId: string, evidence?: FixtureEvidence): number;
	confirmCancel(taskId: string): boolean;
	interrupt(taskId: string): boolean;
	invalidateRunRequest(
		taskId: string,
		reason?: "policy_changed" | "repo_unavailable",
	): boolean;
	invalidateResult(
		taskId: string,
		reason?: "integrity_failed" | "candidate_mutated",
	): boolean;
	corruptEvidence(taskId: string, artifactName: string): boolean;
	/** v1.2: publish legacy v1 proposals from now on (models rows from before the delta). */
	setLegacyContract(on: boolean): void;
	/**
	 * History only: approve + execute a pending legacy Gate 1 the way the PRE-policy hub did. The
	 * routes refuse such a grant today (409 stale_binding, request invalidated, task → draft).
	 */
	runLegacyBeforePolicy(
		taskId: string,
		evidence?: FixtureEvidence,
		/** Engine steps taken before the policy (default: to the end; 0 = queued only). */
		steps?: number,
	): boolean;
	/** v1.2 §C: current validity of the task's accepted result (hub rules; sticky states refuse). */
	setAcceptanceValidity(
		taskId: string,
		status: AcceptanceValidityStatus,
		reason?: AcceptanceValidityReason,
	): boolean;
	expireChallenges(): void;
	revokeSession(): void;
	setReadOnly(readOnly: boolean): void;
	rejectNextSignIn(): void;
	setDecisionFault(fault: DecisionFault | null): void;
	/** Delay answers of one route (or all) by `ms` (race renders in the FX set). */
	setLatency(ms: number, route?: FixtureRoute): void;
	taskIds(): string[];
	/**
	 * Seed a spread of task states for manual review / screenshots, through the transport's own
	 * public routes (create → publish → challenge → decide) plus engine steps. Returns task ids.
	 */
	seedDemo(): Promise<Record<string, string>>;
}

export interface FixtureTransport extends WorkspaceTransport {
	readonly controls: FixtureControls;
}

/** The part of a zod schema the fixture needs (structural; apps/web has no direct zod dependency). */
interface Parser<T> {
	safeParse(
		v: unknown,
	):
		| { success: true; data: T }
		| { success: false; error: { issues: { message: string }[] } };
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createFixtureTransport(
	opts: FixtureWorldOptions = {},
): FixtureTransport {
	const world = new FixtureWorld(opts);
	const latency = new Map<FixtureRoute | "*", number>();

	async function answer<T>(
		route: FixtureRoute,
		schema: Parser<T> | null,
		run: () => TransportResult<T>,
	): Promise<TransportResult<T>> {
		const ms = latency.get(route) ?? latency.get("*") ?? 0;
		if (ms > 0) await sleep(ms);
		const r = run();
		if (!r.ok || schema === null) return r;
		const parsed = schema.safeParse(r.data);
		if (parsed.success)
			return { ok: true, status: r.status, data: parsed.data };
		return {
			ok: false,
			kind: "invalid_response",
			status: r.status,
			message: `fixture answer violates the contract: ${parsed.error.issues[0]?.message ?? "?"}`,
		};
	}

	const controls: FixtureControls = {
		advance: (id, ev) => world.advance(id, ev),
		runToEnd: (id, ev) => {
			let steps = 0;
			while (steps < 32 && world.advance(id, ev)) steps += 1;
			return steps;
		},
		confirmCancel: (id) => world.confirmCancel(id),
		interrupt: (id) => world.interrupt(id),
		invalidateRunRequest: (id, reason) =>
			world.invalidateRunRequest(id, reason),
		invalidateResult: (id, reason) => world.invalidateResult(id, reason),
		corruptEvidence: (id, name) => world.corruptEvidence(id, name),
		setLegacyContract: (on) => world.setLegacyContract(on),
		runLegacyBeforePolicy: (id, ev, steps) =>
			world.runLegacyBeforePolicy(id, ev, steps),
		setAcceptanceValidity: (id, status, reason) =>
			world.setAcceptanceValidity(id, status, reason),
		expireChallenges: () => world.expireChallenges(),
		revokeSession: () => world.revokeSession(),
		setReadOnly: (v) => world.setReadOnly(v),
		rejectNextSignIn: () => world.rejectNextSignIn(),
		setDecisionFault: (f) => world.setDecisionFault(f),
		setLatency: (ms, route) => {
			latency.set(route ?? "*", Math.max(0, Math.floor(ms)));
		},
		taskIds: () => world.taskIds(),
		seedDemo: () => seedDemo(transport, controls),
	};

	const transport: FixtureTransport = {
		source: "fixture",
		controls,
		getSession: () => answer("session", SessionView, () => world.getSession()),
		signIn: (body) =>
			answer("session", SessionView, () => world.signIn(structuredClone(body))),
		signOut: () => answer("session", null, () => world.signOut()),
		getSnapshot: () =>
			answer("snapshot", WorkspaceSnapshot, () => world.getSnapshot()),
		createTask: (body) =>
			answer("command", WorkspaceTaskView, () =>
				world.createTask(structuredClone(body)),
			),
		getTask: (id) =>
			answer("task", WorkspaceTaskDetail, () => world.getTask(id)),
		saveDraft: (id, body) =>
			answer("command", WorkspaceTaskView, () =>
				world.saveDraft(id, structuredClone(body)),
			),
		publishProposal: (id, body) =>
			answer("command", WorkspaceTaskView, () =>
				world.publishProposal(id, structuredClone(body)),
			),
		requestRerun: (id, body) =>
			answer("command", WorkspaceTaskView, () =>
				world.requestRerun(id, structuredClone(body)),
			),
		cancel: (id, body) =>
			answer("command", WorkspaceTaskView, () =>
				world.cancel(id, structuredClone(body)),
			),
		getArtifact: (taskId, artifactId) =>
			answer("artifact", ArtifactTextResponse, () =>
				world.getArtifact(taskId, artifactId),
			),
		issueChallenge: (id, body) =>
			answer("challenge", ChallengeIssueResponse, () =>
				world.issueChallenge(id, structuredClone(body)),
			),
		decide: (id, serialized) =>
			answer("decision", DecisionResponse, () => world.decide(id, serialized)),
	};
	return transport;
}

async function seedDemo(
	t: WorkspaceTransport,
	c: FixtureControls,
): Promise<Record<string, string>> {
	const ids: Record<string, string> = {};
	let n = 0;
	const make = async (
		label: string,
		title: string,
		criteria: string[],
		scenario: WorkspaceDraft["simulation_scenario"] = "approve",
		max_repairs: 0 | 1 = 0,
	) => {
		const r = await t.createTask({
			idempotency_key: `seed-demo-${label}-${++n}`,
			repo_id: "local/fixture",
			draft: {
				...emptyDraft(),
				title,
				objective: `${title}. Keep the change small and covered by the existing checks.`,
				criteria,
				scope: { allowed: ["src", "tests"], protected: [] },
				simulation_scenario: scenario,
				repair_policy: { max_repairs },
				// v1.2: every criterion mapped to trusted checks (the plain draft stays unmapped so
				// the editor's "no check selected" state is visible)
				...(label === "draft"
					? {}
					: {
							criterion_checks: criteria.map((criterion, i) => ({
								criterion,
								checks: i % 2 === 0 ? ["unit"] : ["unit", "lint"],
							})),
						}),
			},
		});
		if (!r.ok) throw new Error(`seed: create ${label}`);
		ids[label] = r.data.task.id;
		return r.data;
	};
	const publish = async (v: WorkspaceTaskView) => {
		const r = await t.publishProposal(v.task.id, { expected_rev: v.task.rev });
		if (!r.ok) throw new Error("seed: publish");
		return r.data;
	};
	const decide = async (
		v: WorkspaceTaskView,
		kind: "run" | "result",
		action: "approve" | "accept" | "request_changes" | "reject",
		reason: string | null = null,
	) => {
		const d = await t.getTask(v.task.id);
		if (!d.ok) throw new Error("seed: detail");
		const req = d.data.approval_requests.find(
			(r) => r.kind === kind && r.status === "pending",
		);
		if (!req) throw new Error("seed: no pending request");
		const ch = await t.issueChallenge(req.id, {
			kind,
			binding_hash: req.binding_hash,
			expected_request_rev: req.rev,
		});
		if (!ch.ok) throw new Error("seed: challenge");
		const grant = action === "approve" || action === "accept";
		const r = await t.decide(
			req.id,
			JSON.stringify({
				idempotency_key: `seed-demo-decision-${++n}`,
				kind,
				action,
				expected_request_rev: ch.data.request_rev,
				binding_hash: req.binding_hash,
				confirmation_text: grant ? "Edward" : null,
				reason: grant ? null : reason,
				challenge: ch.data.challenge,
			}),
		);
		if (!r.ok) throw new Error("seed: decide");
	};

	await make("draft", "Document local setup", [
		"README has a setup section, with commands",
	]);
	// long content (BRW-A-11 within the contract bounds: title ≤ 120, ≤ 20 criteria, path ≤ 200)
	const longTitle = `Unbroken${"Identifier".repeat(11)}`.slice(0, 120);
	const longPath = `src/${"deeply-nested-directory/".repeat(7)}module`.slice(
		0,
		180,
	);
	const longCriteria = Array.from(
		{ length: 20 },
		(_, i) => `Criterion ${i + 1}: ${"keeps, its commas ".repeat(12)}end`,
	);
	const long = await t.createTask({
		idempotency_key: `seed-demo-long-${++n}`,
		repo_id: "local/fixture",
		draft: {
			...emptyDraft(),
			title: longTitle,
			objective: `${"A long objective line, with commas, ".repeat(20)}end.`,
			criteria: longCriteria,
			scope: { allowed: [longPath], protected: [] },
			simulation_scenario: "approve",
			repair_policy: { max_repairs: 0 },
			criterion_checks: longCriteria.map((criterion) => ({
				criterion,
				checks: ["unit", "lint"],
			})),
		},
	});
	if (!long.ok) throw new Error("seed: long");
	ids.long = long.data.task.id;
	await publish(long.data);
	await publish(
		await make("gate1", "Tighten config validation", [
			"Unknown keys are rejected, with the key named",
			"Existing configs still load",
		]),
	);
	const g2 = await publish(
		await make("gate2", "Add retry to webhook sender", [
			"Failed deliveries retry twice, with backoff",
			"Retries are logged once per attempt",
		]),
	);
	await decide(g2, "run", "approve");
	c.runToEnd(g2.task.id);
	const running = await publish(
		await make("running", "Refactor logging setup", [
			"Log lines keep their fields",
		]),
	);
	await decide(running, "run", "approve");
	c.advance(running.task.id);
	c.advance(running.task.id);
	const failed = await publish(
		await make(
			"failed",
			"Speed up test fixtures",
			["Suite runs under one minute"],
			"verification_fails",
		),
	);
	await decide(failed, "run", "approve");
	c.runToEnd(failed.task.id);
	const hang = await publish(
		await make(
			"cancel",
			"Stop the long import job",
			["Import can be stopped"],
			"impl_hangs",
		),
	);
	await decide(hang, "run", "approve");
	c.advance(hang.task.id);
	const cur = await t.getTask(hang.task.id);
	if (cur.ok) await t.cancel(hang.task.id, { expected_rev: cur.data.task.rev });
	const rejected = await publish(
		await make("rejected", "Rename legacy flags", ["Old flags keep working"]),
	);
	await decide(rejected, "run", "reject", "Out of scope for this quarter.");
	const accepted = await publish(
		await make("accepted", "Add health endpoint", [
			"GET /health answers 200, with a version",
		]),
	);
	await decide(accepted, "run", "approve");
	c.runToEnd(accepted.task.id);
	await decide(accepted, "result", "accept");
	return ids;
}
