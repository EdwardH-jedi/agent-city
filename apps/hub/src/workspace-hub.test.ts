// Lead integration: the real hub (Bun.serve on a free loopback port, never 4317) in workspace mode —
// HTTP sign-in with an ephemeral credential, the frozen v1.1 routes through the auth guard, Gate 1
// queueing exactly one execution that the in-hub worker drives with fake adapters, the legacy API
// gone (410), live forced off, and /api/workspace disabled (503) when not configured.
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ArtifactTextResponse,
	ChallengeIssueResponse,
	DecisionResponse,
	SessionView,
	WorkspaceSnapshot,
	WorkspaceTaskDetail,
	WorkspaceTaskView,
} from "@agent-city/schema/workspace-m1";
import { startHub } from "./index.ts";
import { type Fixture, makeFixture } from "./managed/testkit.ts";

const ORIGIN = "http://127.0.0.1:5999"; // the (fake) workspace UI origin
const fixtures: Fixture[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const s of stops.splice(0)) await s();
	for (const f of fixtures.splice(0)) f.cleanup();
});

function hubWith(workspace: boolean) {
	const fx = makeFixture({ dbFile: true });
	fixtures.push(fx);
	const credential = `op-${randomBytes(24).toString("hex")}`; // synthetic, this run only
	const hub = startHub({
		db: fx.db,
		ingestToken: undefined,
		hostname: "127.0.0.1",
		port: 0,
		managed: { config: fx.config, token: undefined },
		managedIdleMs: 30,
		workspace: workspace
			? { operator_credential: credential, allowed_origin: ORIGIN }
			: undefined,
	});
	stops.push(() => hub.stop());
	expect(hub.server.port).not.toBe(4317);
	const base = `http://127.0.0.1:${hub.server.port}`;
	return { fx, hub, base, credential };
}

/** A signed-in browser-like client: exact Origin, HttpOnly cookie, CSRF header on mutations. */
async function signIn(base: string, credential: string) {
	const res = await fetch(`${base}/api/workspace/session`, {
		method: "POST",
		headers: { origin: ORIGIN, "content-type": "application/json" },
		body: JSON.stringify({ credential }),
	});
	expect(res.status).toBe(200);
	const setCookie = res.headers.get("set-cookie") ?? "";
	expect(setCookie).toContain("HttpOnly");
	expect(setCookie).toContain("SameSite=Strict");
	expect(setCookie).not.toContain(credential);
	const cookie = setCookie.split(";")[0] ?? "";
	const session = SessionView.parse(await res.json());
	const call = async (method: string, path: string, body?: unknown) => {
		const r = await fetch(`${base}/api/workspace${path}`, {
			method,
			headers: {
				cookie,
				origin: ORIGIN,
				...(method === "GET"
					? {}
					: {
							"content-type": "application/json",
							"x-agentcity-csrf": session.csrf_token,
						}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await r.text();
		return { status: r.status, body: text ? JSON.parse(text) : null };
	};
	return { call, session };
}

const CRITERION =
	"The fixture check passes, including commas, quotes and ünïcode";
const draft = {
	title: "Wire the workspace hub",
	objective: "Prove the composed hub queues exactly one approved execution.",
	criteria: [CRITERION],
	scope: { allowed: ["."], protected: [] },
	execution_mode: "simulated",
	simulation_scenario: "approve",
	repair_policy: { max_repairs: 0 },
	// v1.2 (explicit): the criterion is covered by the fixture repo's trusted check
	criterion_checks: [{ criterion: CRITERION, checks: ["fixture-check"] }],
};

type Call = Awaited<ReturnType<typeof signIn>>["call"];

/** Create a task, publish it and approve Gate 1; returns the workspace task id. */
async function approveGate1(call: Call, repoId: string): Promise<string> {
	const created = WorkspaceTaskView.parse(
		(
			await call("POST", "/tasks", {
				idempotency_key: `lead-g1-${randomBytes(6).toString("hex")}`,
				repo_id: repoId,
				draft,
			})
		).body,
	);
	const taskId = created.task.id;
	await call("POST", `/tasks/${taskId}/proposals`, {
		expected_rev: created.task.rev,
	});
	const snap = WorkspaceSnapshot.parse((await call("GET", "/snapshot")).body);
	const req = snap.pending_requests.find(
		(r) => r.workspace_task_id === taskId && r.kind === "run",
	);
	if (!req) throw new Error("no pending run request");
	const ch = ChallengeIssueResponse.parse(
		(
			await call("POST", `/approval-requests/${req.id}/challenge`, {
				kind: "run",
				binding_hash: req.binding_hash,
				expected_request_rev: req.rev,
			})
		).body,
	);
	const decided = await call("POST", `/approval-requests/${req.id}/decisions`, {
		idempotency_key: `lead-g1d-${randomBytes(6).toString("hex")}`,
		kind: "run",
		action: "approve",
		expected_request_rev: ch.request_rev,
		binding_hash: req.binding_hash,
		confirmation_text: "Edward",
		reason: null,
		challenge: ch.challenge,
	});
	expect(decided.status).toBe(201);
	return taskId;
}

/** Poll until the bridge has opened the task's pending result request (Gate 2). */
async function waitForGate2(call: Call, taskId: string) {
	for (let i = 0; i < 400; i++) {
		const s = WorkspaceSnapshot.parse((await call("GET", "/snapshot")).body);
		const r = s.pending_requests.find(
			(p) => p.workspace_task_id === taskId && p.kind === "result",
		);
		if (r) return r;
		await Bun.sleep(25);
	}
	throw new Error("Gate 2 never opened");
}

describe("workspace mode on the real hub", () => {
	test("sign in → draft → publish → Gate 1 approve → one execution reaches human_ready", async () => {
		const { fx, base, credential } = hubWith(true);
		const { call } = await signIn(base, credential);

		const created = await call("POST", "/tasks", {
			idempotency_key: `lead-int-${randomBytes(6).toString("hex")}`,
			repo_id: fx.repoId,
			draft,
		});
		expect(created.status).toBe(201);
		const view = WorkspaceTaskView.parse(created.body);
		const taskId = view.task.id;

		const published = await call("POST", `/tasks/${taskId}/proposals`, {
			expected_rev: view.task.rev,
		});
		expect(published.status).toBe(201); // a new proposal version + Gate-1 request were created

		const snap = WorkspaceSnapshot.parse((await call("GET", "/snapshot")).body);
		expect(snap.provenance).toEqual({
			data_source: "hub",
			execution_mode: "simulated",
			live_integration_verified: false,
		});
		const req = snap.pending_requests.find(
			(r) => r.workspace_task_id === taskId && r.kind === "run",
		);
		if (!req) throw new Error("no pending run request");

		const ch = ChallengeIssueResponse.parse(
			(
				await call("POST", `/approval-requests/${req.id}/challenge`, {
					kind: "run",
					binding_hash: req.binding_hash,
					expected_request_rev: req.rev,
				})
			).body,
		);
		const decisionBody = {
			idempotency_key: `lead-dec-${randomBytes(6).toString("hex")}`,
			kind: "run",
			action: "approve",
			expected_request_rev: ch.request_rev,
			binding_hash: req.binding_hash,
			confirmation_text: "Edward",
			reason: null,
			challenge: ch.challenge,
		};
		const decided = await call(
			"POST",
			`/approval-requests/${req.id}/decisions`,
			decisionBody,
		);
		expect(decided.status).toBe(201);
		const receipt = DecisionResponse.parse(decided.body);
		expect(receipt.replayed).toBe(false);

		// lost response: the byte-identical body replays the receipt, nothing new happens
		const replay = await call(
			"POST",
			`/approval-requests/${req.id}/decisions`,
			decisionBody,
		);
		expect(DecisionResponse.parse(replay.body).replayed).toBe(true);

		// the in-hub worker drives exactly one execution with fake adapters
		let detail = WorkspaceTaskDetail.parse(
			(await call("GET", `/tasks/${taskId}`)).body,
		);
		for (let i = 0; i < 200 && detail.engine?.state !== "human_ready"; i++) {
			await Bun.sleep(25);
			detail = WorkspaceTaskDetail.parse(
				(await call("GET", `/tasks/${taskId}`)).body,
			);
		}
		expect(detail.engine?.state).toBe("human_ready");
		const managedRows = fx.db
			.query<{ n: number }, []>("SELECT count(*) AS n FROM managed_tasks")
			.get();
		expect(managedRows?.n).toBe(1);
		expect(detail.runs).toHaveLength(1);
		expect(JSON.stringify(detail)).not.toContain(fx.dir); // no host paths in the read model

		// the bridge seals the result and opens Gate 2 exactly once
		const resultRequest = async () => {
			for (let i = 0; i < 200; i++) {
				const s = WorkspaceSnapshot.parse(
					(await call("GET", "/snapshot")).body,
				);
				const r = s.pending_requests.find(
					(p) => p.workspace_task_id === taskId && p.kind === "result",
				);
				if (r) return r;
				await Bun.sleep(25);
			}
			throw new Error("Gate 2 never opened");
		};
		const g2 = await resultRequest();
		expect(g2.result_envelope_hash).toMatch(/^[0-9a-f]{64}$/);
		const ch2 = ChallengeIssueResponse.parse(
			(
				await call("POST", `/approval-requests/${g2.id}/challenge`, {
					kind: "result",
					binding_hash: g2.binding_hash,
					expected_request_rev: g2.rev,
				})
			).body,
		);
		const accepted = await call(
			"POST",
			`/approval-requests/${g2.id}/decisions`,
			{
				idempotency_key: `lead-acc-${randomBytes(6).toString("hex")}`,
				kind: "result",
				action: "accept",
				expected_request_rev: ch2.request_rev,
				binding_hash: g2.binding_hash,
				confirmation_text: "Edward",
				reason: null,
				challenge: ch2.challenge,
			},
		);
		expect(accepted.status).toBe(201);
		const after = WorkspaceTaskDetail.parse(
			(await call("GET", `/tasks/${taskId}`)).body,
		);
		expect(after.task.stage).toBe("accepted");
		// human acceptance is separate: the engine still says human_ready, nothing else ran
		expect(after.engine?.state).toBe("human_ready");
		expect(after.runs).toHaveLength(1);
		const results = fx.db
			.query<{ n: number }, []>(
				"SELECT count(*) AS n FROM managed_approval_requests WHERE kind = 'result'",
			)
			.get();
		expect(results?.n).toBe(1);
	});

	test("tampered sealed evidence: accept → 409 + invalidated, and the artifact then reads non-verified with no text", async () => {
		const { fx, base, credential } = hubWith(true);
		const { call } = await signIn(base, credential);
		const taskId = await approveGate1(call, fx.repoId);
		const g2 = await waitForGate2(call, taskId);

		const detail = WorkspaceTaskDetail.parse(
			(await call("GET", `/tasks/${taskId}`)).body,
		);
		const diff = detail.artifacts.find(
			(a) => a.name === "diff.patch" && a.run_id === g2.run_id,
		);
		if (!diff) throw new Error("no sealed diff artifact");
		const before = ArtifactTextResponse.parse(
			(await call("GET", `/tasks/${taskId}/artifacts/${diff.artifact_id}`))
				.body,
		);
		expect(before.status).toBe("verified");

		// flip one byte of the stored artifact (fixture directory only)
		const rel = fx.db
			.query<{ rel_path: string }, [string]>(
				"SELECT rel_path FROM managed_artifacts WHERE id = ?",
			)
			.get(diff.artifact_id)?.rel_path;
		if (!rel) throw new Error("artifact row missing");
		const file = join(fx.config.artifacts_root, rel);
		const bytes = readFileSync(file);
		bytes[0] = (bytes[0] ?? 0) ^ 0x01;
		writeFileSync(file, bytes);

		const ch = ChallengeIssueResponse.parse(
			(
				await call("POST", `/approval-requests/${g2.id}/challenge`, {
					kind: "result",
					binding_hash: g2.binding_hash,
					expected_request_rev: g2.rev,
				})
			).body,
		);
		const accept = await call("POST", `/approval-requests/${g2.id}/decisions`, {
			idempotency_key: `lead-tamper-${randomBytes(6).toString("hex")}`,
			kind: "result",
			action: "accept",
			expected_request_rev: ch.request_rev,
			binding_hash: g2.binding_hash,
			confirmation_text: "Edward",
			reason: null,
			challenge: ch.challenge,
		});
		expect(accept.status).toBe(409);
		expect(accept.body.error).toBe("integrity_failed");

		const after = WorkspaceTaskDetail.parse(
			(await call("GET", `/tasks/${taskId}`)).body,
		);
		expect(after.task.stage).not.toBe("accepted");
		expect(after.approval_requests.find((r) => r.id === g2.id)?.status).toBe(
			"invalidated",
		);
		// the retained sealed copy is NOT served as current evidence once the result is invalidated
		const art = ArtifactTextResponse.parse(
			(await call("GET", `/tasks/${taskId}/artifacts/${diff.artifact_id}`))
				.body,
		);
		expect(art.status).not.toBe("verified");
		expect(art.text).toBeNull();
	});

	test("a managed task queued outside Gate 1 never launches (authorize denies before preflight)", async () => {
		const { fx, base, credential } = hubWith(true);
		await signIn(base, credential); // workspace is live; the legacy route is 410 anyway
		const { submitTask, runTask } = await import("./managed/service.ts");
		const deps = { db: fx.db, config: fx.config };
		const { task } = await submitTask(deps, {
			idempotency_key: `bypass-${randomBytes(6).toString("hex")}`,
			repo_id: fx.repoId,
			title: "Bypass attempt",
			objective: "Queued directly, without a workspace decision.",
			acceptance_criteria: ["Never runs"],
			approved_scope: ["."],
			execution_mode: "simulated",
			simulation_scenario: "approve",
			repair_limit: 0,
		});
		runTask(deps, task.id); // a non-workspace row: the legacy service still queues it
		const { getTask, listRuns } = await import("./managed/store.ts");
		for (let i = 0; i < 200 && getTask(fx.db, task.id)?.state === "queued"; i++)
			await Bun.sleep(20);
		const t = getTask(fx.db, task.id);
		expect(t?.state).toBe("blocked");
		expect(t?.failure_kind).toBe("approval_void");
		expect(listRuns(fx.db, task.id)).toHaveLength(0);
	});

	test("legacy /api/managed is gone (410) and the workspace refuses anonymous callers", async () => {
		const { base } = hubWith(true);
		const legacy = await fetch(`${base}/api/managed/tasks`);
		expect(legacy.status).toBe(410);
		const run = await fetch(
			`${base}/api/managed/tasks/task-00000000-0000-0000-0000-000000000000/run`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			},
		);
		expect(run.status).toBe(410);
		expect((await fetch(`${base}/api/workspace/snapshot`)).status).toBe(401);
		// no credentialed CORS for the workspace from another loopback port
		const pre = await fetch(`${base}/api/workspace/snapshot`, {
			method: "OPTIONS",
			headers: {
				origin: "http://127.0.0.1:6123",
				"access-control-request-method": "POST",
			},
		});
		expect(pre.headers.get("access-control-allow-origin")).toBeNull();
	});

	test("live is forced off in workspace mode even when the trusted config enables it", async () => {
		const fx = makeFixture({ dbFile: true, liveStubs: {} });
		fixtures.push(fx);
		expect(fx.config.live.enabled).toBe(true);
		const hub = startHub({
			db: fx.db,
			ingestToken: undefined,
			hostname: "127.0.0.1",
			port: 0,
			managed: { config: fx.config, token: undefined },
			workspace: {
				operator_credential: `op-${randomBytes(24).toString("hex")}`,
				allowed_origin: ORIGIN,
			},
		});
		stops.push(() => hub.stop());
		expect(hub.workspace).not.toBeNull();
		const res = await fetch(
			`http://127.0.0.1:${hub.server.port}/api/managed/config`,
		);
		expect(res.status).toBe(410);
	});

	test("without workspace configuration /api/workspace answers 503 and the legacy API is unchanged", async () => {
		const { base, hub } = hubWith(false);
		expect(hub.workspace).toBeNull();
		const res = await fetch(`${base}/api/workspace/snapshot`);
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: string }).error).toBe("disabled");
		// legacy managed API still guarded by its own (unset) token → 503, not 410
		expect((await fetch(`${base}/api/managed/tasks`)).status).toBe(503);
	});
});
