// End to end through `app.request` with the lead's composition:
//   ws = new Hono(); auth.install(ws); ws.route("/", createWorkspaceRouter(deps)); app.route(BASE, ws)
// Real auth (exact Origin + CSRF + HttpOnly cookie), real store, real engine (fake adapters).
import { afterEach, describe, expect, test } from "bun:test";
import {
	ArtifactTextResponse,
	ChallengeIssueResponse,
	DecisionResponse,
	WORKSPACE_ERROR_STATUS,
	WorkspaceErrorBody,
	type WorkspaceErrorCode,
	WorkspaceSnapshot,
	WorkspaceTaskDetail,
	WorkspaceTaskView,
} from "@agent-city/schema/workspace-m1";
import { getTask } from "../../managed/store.ts";
import {
	draft,
	type Env,
	key,
	makeEnv,
	openGate2,
	runEngine,
	type Session,
} from "./test-support.ts";

const envs: Env[] = [];
afterEach(() => {
	for (const e of envs.splice(0)) e.fx.cleanup();
});
const env = () => {
	const e = makeEnv();
	envs.push(e);
	return e;
};

async function bodyOf(res: Response): Promise<unknown> {
	const text = await res.text();
	return text.length > 0 ? JSON.parse(text) : null;
}

/** Error responses: the closed WorkspaceErrorBody with a status that matches its code. */
async function expectError(res: Response, code: WorkspaceErrorCode) {
	const body = WorkspaceErrorBody.parse(await bodyOf(res));
	expect({ status: res.status, error: body.error }).toEqual({
		status: WORKSPACE_ERROR_STATUS[body.error],
		error: code,
	});
	expect(res.headers.get("cache-control")).toBe("no-store");
	return body;
}

const fakeTask = () => `wst-${crypto.randomUUID()}`;
const fakeReq = () => `wsa-${crypto.randomUUID()}`;
const fakeArt = () => `art-${crypto.randomUUID()}`;

describe("guard in front of every route (lead composition)", () => {
	test("unauthenticated → 401 on every route, including crafted live bodies and HEAD", async () => {
		const e = env();
		const t = fakeTask();
		const r = fakeReq();
		const live = {
			idempotency_key: key(),
			repo_id: e.fx.repoId,
			draft: { ...draft(), execution_mode: "live" },
		};
		const routes: [string, string, unknown][] = [
			["GET", "/snapshot", undefined],
			["HEAD", "/snapshot", undefined],
			["POST", "/tasks", live],
			["GET", `/tasks/${t}`, undefined],
			["PUT", `/tasks/${t}/draft`, { expected_rev: 1, draft: draft() }],
			["POST", `/tasks/${t}/proposals`, { expected_rev: 1 }],
			["POST", `/tasks/${t}/rerun`, { expected_rev: 1, proposal_id: null }],
			["POST", `/tasks/${t}/cancel`, { expected_rev: 1 }],
			["GET", `/tasks/${t}/artifacts/${fakeArt()}`, undefined],
			["POST", `/approval-requests/${r}/challenge`, { kind: "run" }],
			["POST", `/approval-requests/${r}/decisions`, { execution_mode: "live" }],
			["DELETE", `/tasks/${t}`, undefined],
		];
		for (const [method, path, body] of routes) {
			const res = await e.request(method, path, null, body);
			expect({ method, path, status: res.status }).toEqual({
				method,
				path,
				status: 401,
			});
		}
	});

	test("foreign Origin / missing CSRF → 403; read-only principal: reads 200, mutations 403", async () => {
		const e = env();
		const s = await e.login();
		const body = {
			idempotency_key: key(),
			repo_id: e.fx.repoId,
			draft: draft(),
		};
		await expectError(
			await e.request("POST", "/tasks", s, body, {
				origin: "http://127.0.0.1:5174",
			}),
			"forbidden_origin",
		);
		await expectError(
			await e.request("POST", "/tasks", s, body, {
				"x-agentcity-csrf": undefined,
			}),
			"csrf_invalid",
		);
		const viewer = await e.login(e.readOnlyCredential);
		expect((await e.request("GET", "/snapshot", viewer)).status).toBe(200);
		await expectError(
			await e.request("POST", "/tasks", viewer, body),
			"forbidden_scope",
		);
		expect(e.store.listTasks().length).toBe(0);
	});
});

describe("full flow over HTTP", () => {
	test("create → draft → publish → challenge → approve → engine → Gate 2 → accept; every body validates", async () => {
		const e = env();
		const s: Session = await e.login();
		const createBody = {
			idempotency_key: key("http"),
			repo_id: e.fx.repoId,
			draft: draft(),
		};
		const c1 = await e.request("POST", "/tasks", s, createBody);
		expect(c1.status).toBe(201);
		expect(c1.headers.get("cache-control")).toBe("no-store");
		const v1 = WorkspaceTaskView.parse(await bodyOf(c1));
		const id = v1.task.id;
		// replay and conflict on the create key
		expect((await e.request("POST", "/tasks", s, createBody)).status).toBe(200);
		await expectError(
			await e.request("POST", "/tasks", s, {
				...createBody,
				draft: draft({ title: "Other" }),
			}),
			"idempotency_conflict",
		);
		const d = await e.request("PUT", `/tasks/${id}/draft`, s, {
			expected_rev: v1.task.rev,
			draft: draft({
				criteria: ["The fixture check passes", "Nothing else changes"],
			}),
		});
		expect(d.status).toBe(200);
		const v2 = WorkspaceTaskView.parse(await bodyOf(d));
		const p = await e.request("POST", `/tasks/${id}/proposals`, s, {
			expected_rev: v2.task.rev,
		});
		expect(p.status).toBe(201);
		const v3 = WorkspaceTaskView.parse(await bodyOf(p));
		const req = v3.approval_requests[0];
		if (!req) throw new Error("no request");

		const snap = await e.request("GET", "/snapshot", s);
		expect(snap.status).toBe(200);
		const snapText = await snap.clone().text();
		const snapshot = WorkspaceSnapshot.parse(await bodyOf(snap));
		expect(snapshot.provenance).toEqual({
			data_source: "hub",
			execution_mode: "simulated",
			live_integration_verified: false,
		});
		expect(snapshot.repos).toEqual([
			{
				repo_id: e.fx.repoId,
				base_ref: "main",
				required_checks: ["fixture-check"],
			},
		]);
		expect(snapshot.pending_requests.map((r) => r.id)).toEqual([req.id]);
		expect(snapText).not.toContain("challenge_");
		expect(snapText).not.toContain(e.fx.dir);

		const ch = await e.request(
			"POST",
			`/approval-requests/${req.id}/challenge`,
			s,
			{
				kind: "run",
				binding_hash: req.binding_hash,
				expected_request_rev: req.rev,
			},
		);
		expect(ch.status).toBe(201);
		const issued = ChallengeIssueResponse.parse(await bodyOf(ch));
		const decision = {
			idempotency_key: key("http-decide"),
			kind: "run",
			action: "approve",
			expected_request_rev: issued.request_rev,
			binding_hash: req.binding_hash,
			confirmation_text: "Edward",
			reason: null,
			challenge: issued.challenge,
		};
		const a = await e.request(
			"POST",
			`/approval-requests/${req.id}/decisions`,
			s,
			decision,
		);
		expect(a.status).toBe(201);
		const receipt = DecisionResponse.parse(await bodyOf(a));
		expect(receipt.replayed).toBe(false);
		const replay = await e.request(
			"POST",
			`/approval-requests/${req.id}/decisions`,
			s,
			decision,
		);
		expect(replay.status).toBe(201);
		const replayed = DecisionResponse.parse(await bodyOf(replay));
		expect(replayed.replayed).toBe(true);
		expect(replayed.receipt).toEqual(receipt.receipt);

		await runEngine(e);
		const result = await openGate2(e, {
			taskId: id,
			runRequestId: req.id,
			managedTaskId: req.managed_task_id,
			decisionId: receipt.receipt.decision_id,
		});
		const detailRes = await e.request("GET", `/tasks/${id}`, s);
		expect(detailRes.status).toBe(200);
		const detailText = await detailRes.clone().text();
		const detail = WorkspaceTaskDetail.parse(await bodyOf(detailRes));
		expect(detail.task.stage).toBe("awaiting_acceptance");
		expect(detail.phase).toBe("awaiting_acceptance");
		expect(detail.engine?.state).toBe("human_ready");
		expect(detail.runs).toHaveLength(1);
		expect(detail.runs[0]?.attempt_no).toBe(1);
		expect(detail.artifacts.map((x) => x.name)).toEqual(
			expect.arrayContaining([
				"diff.patch",
				"manifest.json",
				"review-output.json",
			]),
		);
		expect(detail.decisions).toHaveLength(1);
		// never host paths, pids, challenge columns or create internals
		for (const needle of [
			e.fx.dir,
			"workspace_path",
			"rel_path",
			"child_pid",
			"challenge_hash",
			"idempotency_key",
			"request_hash",
		])
			expect(detailText).not.toContain(needle);

		const diff = detail.artifacts.find((x) => x.name === "diff.patch");
		const art = await e.request(
			"GET",
			`/tasks/${id}/artifacts/${diff?.artifact_id}`,
			s,
		);
		expect(art.status).toBe(200);
		const shown = ArtifactTextResponse.parse(await bodyOf(art));
		expect(shown.status).toBe("verified");
		expect(shown.text).toContain("agentcity-sim");

		const ch2 = ChallengeIssueResponse.parse(
			await bodyOf(
				await e.request(
					"POST",
					`/approval-requests/${result.id}/challenge`,
					s,
					{
						kind: "result",
						binding_hash: result.binding_hash,
						expected_request_rev: result.rev,
					},
				),
			),
		);
		const accept = await e.request(
			"POST",
			`/approval-requests/${result.id}/decisions`,
			s,
			{
				idempotency_key: key("http-accept"),
				kind: "result",
				action: "accept",
				expected_request_rev: ch2.request_rev,
				binding_hash: result.binding_hash,
				confirmation_text: "Edward",
				reason: null,
				challenge: ch2.challenge,
			},
		);
		expect(accept.status).toBe(201);
		expect(DecisionResponse.parse(await bodyOf(accept)).receipt.action).toBe(
			"accept",
		);
		expect(getTask(e.db, req.managed_task_id)?.state).toBe("human_ready");
		const final = WorkspaceTaskDetail.parse(
			await bodyOf(await e.request("GET", `/tasks/${id}`, s)),
		);
		expect(final.task.stage).toBe("accepted");
		expect(final.phase).toBe("accepted");
	});
});

describe("input hygiene", () => {
	test("unknown fields → 400 without echo; malformed JSON → 400; oversized → 413; __proto__ → 400", async () => {
		const e = env();
		const s = await e.login();
		const marker = `marker${crypto.randomUUID().replaceAll("-", "")}`;
		const res = await e.request("POST", "/tasks", s, {
			idempotency_key: key(),
			repo_id: e.fx.repoId,
			draft: draft(),
			[marker]: marker,
		});
		const text = await res.clone().text();
		await expectError(res, "invalid_request");
		expect(text).not.toContain(marker);
		await expectError(
			await e.request("POST", "/tasks", s, "{not json"),
			"invalid_request",
		);
		await expectError(
			await e.request("POST", "/tasks", s, `﻿${JSON.stringify({ a: 1 })}`),
			"invalid_request",
		);
		await expectError(
			await e.request(
				"POST",
				"/tasks",
				s,
				JSON.stringify({ pad: "x".repeat(70_000) }),
			),
			"payload_too_large",
		);
		await expectError(
			await e.request(
				"POST",
				"/tasks",
				s,
				`{"__proto__":{"admin":true},"idempotency_key":"${key()}","repo_id":"${e.fx.repoId}","draft":${JSON.stringify(draft())}}`,
			),
			"invalid_request",
		);
		const deep = `${"[".repeat(5000)}${"]".repeat(5000)}`;
		await expectError(
			await e.request("POST", "/tasks", s, deep),
			"invalid_request",
		);
		expect(e.store.listTasks().length).toBe(0);
	});

	test("invalid enum values in a decision body → 400, never echoed, never 500", async () => {
		const e = env();
		const s = await e.login();
		const v = await e.ctx(s);
		const { createTask, publish, challenge, decisionBody } = await import(
			"./test-support.ts"
		);
		const created = await createTask(e, v);
		const { request } = await publish(e, v, created.task.id);
		const ch = challenge(e, v, request.id);
		const snapshot = (await import("./test-support.ts")).dump(e.db);
		for (const over of [
			{ action: "DROP-TABLE-xyz123" },
			{ kind: "bogus-xyz123" },
			{ kind: "bogus-xyz123", action: "zzz-xyz123" },
			{ kind: "result" }, // approve is not an action of the result gate
			{ confirmation_text: "x".repeat(65) },
		]) {
			const res = await e.request(
				"POST",
				`/approval-requests/${request.id}/decisions`,
				s,
				{ ...decisionBody(ch), ...over },
			);
			const text = await res.clone().text();
			await expectError(res, "invalid_request");
			expect(text).not.toContain("xyz123");
		}
		expect((await import("./test-support.ts")).dump(e.db)).toBe(snapshot);
	});

	test("ids are pattern-checked → 404; unknown routes / methods → 404", async () => {
		const e = env();
		const s = await e.login();
		for (const path of [
			"/tasks/wst-1",
			`/tasks/${fakeTask().toUpperCase()}`,
			"/tasks/%2e%2e%2fsnapshot",
			`/tasks/${fakeTask()}`,
			`/tasks/${fakeTask()}/artifacts/art-1`,
			`/tasks/${fakeTask()}/artifacts/${fakeArt()}`,
			"/nope",
		])
			await expectError(await e.request("GET", path, s), "not_found");
		await expectError(
			await e.request("DELETE", `/tasks/${fakeTask()}`, s),
			"not_found",
		);
		await expectError(
			await e.request("POST", "/approval-requests/wsa-x/challenge", s, {
				kind: "run",
				binding_hash: "ab".repeat(32),
				expected_request_rev: 1,
			}),
			"not_found",
		);
	});

	test("authenticated live request → 422 live_disabled (after auth, before any preflight)", async () => {
		const e = env();
		const s = await e.login();
		await expectError(
			await e.request("POST", "/tasks", s, {
				idempotency_key: key(),
				repo_id: e.fx.repoId,
				draft: { ...draft(), execution_mode: "live" },
			}),
			"live_disabled",
		);
	});

	test("an artifact of another workspace task is not readable through this task", async () => {
		const e = env();
		const s = await e.login();
		const v = await e.ctx(s);
		const { approvedTask } = await import("./test-support.ts");
		const a = await approvedTask(e, v);
		await runEngine(e);
		const other = WorkspaceTaskView.parse(
			await bodyOf(
				await e.request("POST", "/tasks", s, {
					idempotency_key: key(),
					repo_id: e.fx.repoId,
					draft: draft({ title: "Other" }),
				}),
			),
		);
		const detail = WorkspaceTaskDetail.parse(
			await bodyOf(await e.request("GET", `/tasks/${a.taskId}`, s)),
		);
		const art = detail.artifacts[0];
		if (!art) throw new Error("no artifact");
		expect(
			(
				await e.request(
					"GET",
					`/tasks/${a.taskId}/artifacts/${art.artifact_id}`,
					s,
				)
			).status,
		).toBe(200);
		await expectError(
			await e.request(
				"GET",
				`/tasks/${other.task.id}/artifacts/${art.artifact_id}`,
				s,
			),
			"not_found",
		);
	});
});
