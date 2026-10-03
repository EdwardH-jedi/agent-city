// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests inspect raw, untyped HTTP bodies and SQLite rows on purpose
// ADV-LIVE, ADV-LEGACY, ADV-WS — crafted live mode against a config whose live block is ENABLED
// (stub claude/codex executables that log every spawn), legacy direct-run bypasses, and managed /
// workspace leakage on the public /ws and the observed read API.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_INTEGRATION_VERIFIED } from "@agent-city/schema";
import {
	approvalHashFor,
	runTask,
	submitTask,
} from "../../src/managed/service.ts";
import {
	approveGate1,
	assertIsolation,
	BASE,
	composedHub,
	count,
	createTask,
	cred,
	decide,
	decisionBody,
	dump,
	http,
	issueChallenge,
	key,
	linkage,
	liveServers,
	openGate1,
	realHub,
	rows,
	taskView,
	teardown,
	toGate2,
	waitStage,
	draft as wsDraft,
} from "./harness.ts";

assertIsolation();
afterEach(teardown);
afterAll(() => expect(liveServers).toBe(0));

const LIVE = { fixture: { liveStubs: {} } };

describe("ADV-LIVE crafted live mode → zero provider spawns", () => {
	test("ADV-LIVE-01/02 live (and every non-simulated variant) in create / save-draft → 422 live_disabled, nothing reserved, zero spawns", async () => {
		const H = realHub(LIVE);
		expect(H.fx.config.live.enabled).toBe(true);
		const c = await H.signIn();
		const before = dump(H.db);
		for (const mode of [
			"live",
			"Live",
			"LIVE",
			" live",
			"simulated ",
			["live"],
			null,
			1,
			{ live: true },
		]) {
			const r = await c.post("/tasks", {
				idempotency_key: key(),
				repo_id: H.fx.repoId,
				draft: { ...wsDraft(), execution_mode: mode },
			});
			expect([JSON.stringify(mode), r.status, r.body.error]).toEqual([
				JSON.stringify(mode),
				422,
				"live_disabled",
			]);
		}
		const t = await createTask(c, H.fx);
		const save = await c.req("PUT", `/tasks/${t.id}/draft`, {
			expected_rev: t.rev,
			draft: { ...wsDraft(), execution_mode: "live" },
		});
		expect([save.status, save.body.error]).toEqual([422, "live_disabled"]);
		expect(dump(H.db).replace(/workspace_tasks:.*\n/, "")).toBe(
			before.replace(/workspace_tasks:.*\n/, ""),
		);
		// unauthenticated crafted live request: 401 first (OQ-1)
		const anon = await http(
			H.base,
			"POST",
			`${BASE}/tasks`,
			{
				idempotency_key: key(),
				repo_id: H.fx.repoId,
				draft: { ...wsDraft(), execution_mode: "live" },
			},
			{ cookie: null },
		);
		expect(anon.status).toBe(401);
		expect(H.providerSpawns()).toBe(0);
	});

	test("ADV-LIVE-03/04 provider / model / argv fields and mode overrides on every body → 4xx, zero spawns", async () => {
		const H = realHub(LIVE);
		const c = await H.signIn();
		const g = await openGate1(c, H.fx);
		const bad: [string, unknown][] = [
			["provider_profiles", { implementer: "claude", reviewer: "codex" }],
			["model", "stub-model"],
			["argv", ["/bin/sh", "-c", "id"]],
			["executable", "/usr/bin/env"],
			["live", true],
		];
		for (const [k, v] of bad) {
			const r = await c.post("/tasks", {
				idempotency_key: key(),
				repo_id: H.fx.repoId,
				draft: { ...wsDraft(), [k]: v },
			});
			expect([k, r.status]).toEqual([k, 400]);
		}
		const v = await taskView(c, g.taskId);
		for (const [path, body] of [
			[
				`/tasks/${g.taskId}/proposals`,
				{ expected_rev: v.task.rev, execution_mode: "live" },
			],
			[
				`/tasks/${g.taskId}/rerun`,
				{
					expected_rev: v.task.rev,
					proposal_id: v.task.current_proposal_id,
					execution_mode: "live",
				},
			],
			[
				`/approval-requests/${g.req.id}/challenge`,
				{
					kind: "run",
					binding_hash: g.req.binding_hash,
					expected_request_rev: g.req.rev,
					execution_mode: "live",
				},
			],
		] as [string, unknown][]) {
			const r = await c.post(path, body);
			expect([path, r.status, r.body.error]).toEqual([
				path,
				422,
				"live_disabled",
			]);
		}
		const ch = await issueChallenge(c, g.req);
		const d = await decide(c, g.req, {
			...decisionBody(g.req, ch, "approve"),
			execution_mode: "live",
		});
		expect([d.status, d.body.error]).toEqual([422, "live_disabled"]);
		const deep = await c.post("/tasks", {
			idempotency_key: key(),
			repo_id: H.fx.repoId,
			draft: wsDraft(),
			x: { a: { b: { c: { d: { e: { f: { execution_mode: "live" } } } } } } },
		});
		expect([400, 422]).toContain(deep.status);
		expect(linkage(H.db, g.req.managed_task_id).decisions).toBe(0);
		expect(H.providerSpawns()).toBe(0);
	});

	test("ADV-LIVE-05 approved simulated execution flipped to live in the DB → blocked before preflight; zero spawns, no live adapter lookup", async () => {
		const H = composedHub({ ...LIVE, manual: true });
		const c = await H.signIn();
		const a = await approveGate1(c, H.fx);
		H.db
			.query(
				"UPDATE managed_tasks SET execution_mode = 'live', simulation_scenario = NULL WHERE id = ?",
			)
			.run(a.managedTaskId);
		await H.drain();
		const t = H.db
			.query("SELECT state, failure_kind FROM managed_tasks WHERE id = ?")
			.get(a.managedTaskId) as any;
		expect(t.state).toBe("blocked");
		expect(t.failure_kind).toBe("approval_void");
		expect([
			H.calls.preflight,
			H.calls.implement,
			H.calls.review,
			H.calls.lookups.live,
		]).toEqual([0, 0, 0, 0]);
		expect(H.providerSpawns()).toBe(0);
	});

	test("ADV-LIVE-06 legacy live submit + Run over HTTP → 410; zero spawns", async () => {
		const H = realHub(LIVE);
		const submit = await http(
			H.base,
			"POST",
			"/api/managed/tasks",
			{
				idempotency_key: key(),
				repo_id: H.fx.repoId,
				title: "x",
				objective: "x",
				acceptance_criteria: ["x"],
				approved_scope: ["."],
				execution_mode: "live",
			},
			{ headers: { authorization: `Bearer ${cred()}` } },
		);
		expect(submit.status).toBe(410);
		expect(H.providerSpawns()).toBe(0);
	});

	test("ADV-LIVE-07 unknown simulation scenario → 400", async () => {
		const H = realHub(LIVE);
		const c = await H.signIn();
		const r = await c.post("/tasks", {
			idempotency_key: key(),
			repo_id: H.fx.repoId,
			draft: { ...wsDraft(), simulation_scenario: "rm_rf_everything" },
		});
		expect(r.status).toBe(400);
	});

	test("ADV-LIVE-08/09 a full journey on a live-ENABLED config runs only fake adapters; provenance says simulated", async () => {
		const H = realHub(LIVE);
		const c = await H.signIn();
		const g = await toGate2(c, H.fx);
		const runs = rows(
			H.db,
			"SELECT provider, mode FROM managed_runs WHERE task_id = ?",
			g.managedTaskId,
		);
		expect(runs).toEqual([{ provider: "fake", mode: "simulated" }]);
		const reviews = rows(
			H.db,
			"SELECT provider, mode FROM managed_reviews WHERE task_id = ?",
			g.managedTaskId,
		);
		expect(reviews).toEqual([{ provider: "fake", mode: "simulated" }]);
		const snap = (await c.get("/snapshot")).body;
		expect(snap.provenance).toEqual({
			data_source: "hub",
			execution_mode: "simulated",
			live_integration_verified: false,
		});
		const env = JSON.parse(
			(
				H.db
					.query(
						"SELECT result_envelope FROM managed_approval_requests WHERE id = ?",
					)
					.get(g.g2.id) as any
			).result_envelope,
		);
		expect(env.execution_mode).toBe("simulated");
		expect(H.providerSpawns()).toBe(0);
		expect(LIVE_INTEGRATION_VERIFIED).toBe(false);
	});
});

describe("ADV-LEGACY direct-run bypasses", () => {
	test("ADV-LEGACY-01/04/05/06 every legacy /api/managed route answers 410 with no data, bearer or not", async () => {
		const H = realHub();
		const c = await H.signIn();
		const g = await openGate1(c, H.fx);
		const before = dump(H.db);
		const mt = g.req.managed_task_id;
		for (const [m, p] of [
			["GET", "/api/managed/config"],
			["GET", "/api/managed/tasks"],
			["GET", `/api/managed/tasks/${mt}`],
			["POST", "/api/managed/tasks"],
			["POST", `/api/managed/tasks/${mt}/run`],
			["POST", `/api/managed/tasks/${mt}/cancel`],
			[
				"GET",
				`/api/managed/tasks/${mt}/artifacts/art-00000000-0000-0000-0000-000000000000`,
			],
		]) {
			for (const auth of [undefined, `Bearer ${cred()}`]) {
				const r = await http(
					H.base,
					m as string,
					p as string,
					m === "POST" ? {} : undefined,
					auth ? { headers: { authorization: auth } } : {},
				);
				expect([m, p, r.status]).toEqual([m, p, 410]);
				expect(r.text).not.toContain(mt);
			}
		}
		expect(dump(H.db)).toBe(before);
	});

	test("ADV-LEGACY-02/03 the legacy service Run refuses workspace-governed executions (draft, blocked) in-process too", async () => {
		const H = composedHub({ manual: true });
		const c = await H.signIn();
		const g = await openGate1(c, H.fx);
		const deps = { db: H.db, config: H.fx.config };
		expect(() => runTask(deps, g.req.managed_task_id)).toThrow();
		expect(linkage(H.db, g.req.managed_task_id).state).toBe("draft");
		// blocked execution (authorization voided) cannot be re-queued by the legacy path either
		const a = await approveGate1(c, H.fx);
		H.db
			.query("UPDATE managed_tasks SET title = title || '!' WHERE id = ?")
			.run(a.managedTaskId);
		await H.drain();
		expect(linkage(H.db, a.managedTaskId).state).toBe("blocked");
		expect(() => runTask(deps, a.managedTaskId)).toThrow();
		expect(linkage(H.db, a.managedTaskId).state).toBe("blocked");
		expect(H.calls.implement).toBe(0);
	});

	test("ADV-LEGACY-07 a row queued outside Gate 1 with a valid content approval_hash → refused before preflight", async () => {
		const H = composedHub({ manual: true });
		const deps = { db: H.db, config: H.fx.config };
		const { task } = await submitTask(deps, {
			idempotency_key: key("seed"),
			repo_id: H.fx.repoId,
			title: "Seeded queued row",
			objective: "Queued by a raw DB writer with a correct content hash.",
			acceptance_criteria: ["never runs"],
			approved_scope: ["."],
			execution_mode: "simulated",
			simulation_scenario: "approve",
			repair_limit: 0,
		});
		const hash = approvalHashFor(task, H.fx.config);
		H.db
			.query(
				"UPDATE managed_tasks SET state = 'queued', approval_hash = ?, run_requested_at = ?, fence_token = fence_token + 1 WHERE id = ?",
			)
			.run(hash, new Date().toISOString(), task.id);
		await H.drain();
		const t = H.db
			.query("SELECT state, failure_kind FROM managed_tasks WHERE id = ?")
			.get(task.id) as any;
		expect(t).toEqual({ state: "blocked", failure_kind: "approval_void" });
		expect([H.calls.preflight, H.calls.implement]).toEqual([0, 0]);
		expect(
			count(
				H.db,
				"SELECT count(*) AS n FROM managed_runs WHERE task_id = ?",
				task.id,
			),
		).toBe(0);
	});

	test("ADV-LEGACY-08 v011-style rows (draft / human_ready, no linkage) stay history: no workspace task, no request, no decision", async () => {
		const H = composedHub({ manual: true });
		const deps = { db: H.db, config: H.fx.config };
		const ids: string[] = [];
		for (const state of ["draft", "human_ready", "failed"]) {
			const { task } = await submitTask(deps, {
				idempotency_key: key("legacy"),
				repo_id: H.fx.repoId,
				title: `Legacy ${state}`,
				objective: "Pre-M1 history.",
				acceptance_criteria: ["x"],
				approved_scope: ["."],
				execution_mode: "simulated",
				simulation_scenario: "approve",
				repair_limit: 1,
			});
			if (state !== "draft")
				H.db
					.query("UPDATE managed_tasks SET state = ? WHERE id = ?")
					.run(state, task.id);
			ids.push(task.id);
		}
		await H.bridge.sweep();
		await H.drain();
		const c = await H.signIn();
		const snap = (await c.get("/snapshot")).text;
		for (const id of ids) expect(snap).not.toContain(id);
		expect(
			count(H.db, "SELECT count(*) AS n FROM managed_approval_requests"),
		).toBe(0);
		expect(count(H.db, "SELECT count(*) AS n FROM managed_decisions")).toBe(0);
		expect(count(H.db, "SELECT count(*) AS n FROM workspace_tasks")).toBe(0);
		expect(
			rows(H.db, "SELECT state FROM managed_tasks ORDER BY created_at").map(
				(r) => r.state,
			),
		).toEqual(["draft", "human_ready", "failed"]);
	});

	test("ADV-LEGACY-09 static: no hub route reaches runTask / requestRun except the legacy router (410 in workspace mode)", () => {
		const root = join(import.meta.dir, "..", "..", "src");
		const read = (rel: string) => readFileSync(join(root, rel), "utf8");
		expect(read("routes/managed.ts")).toContain("runTask(");
		for (const rel of [
			"routes/api.ts",
			"routes/ws.ts",
			"routes/ingest.ts",
			"workspace-hub.ts",
			"workspace-m1/decisions/router.ts",
			"workspace-m1/decisions/commands.ts",
			"workspace-m1/decisions/decision-service.ts",
			"workspace-m1/bridge/bridge.ts",
			"workspace-m1/bridge/reconciler.ts",
		]) {
			const src = read(rel);
			expect([rel, /\brunTask\(|\brequestRun\(/.test(src)]).toEqual([
				rel,
				false,
			]);
		}
		const index = read("index.ts");
		expect(index).toContain("legacyManagedGone()");
		expect(index).not.toContain('publish("managed"');
	});
});

describe("ADV-WS public socket and observed read API", () => {
	async function tap(base: string, origin: string | null) {
		const url = `${base.replace("http", "ws")}/ws`;
		const frames: string[] = [];
		const ws = new WebSocket(
			url,
			origin ? ({ headers: { origin } } as any) : undefined,
		);
		const opened = await new Promise<boolean>((resolve) => {
			ws.onopen = () => resolve(true);
			ws.onerror = () => resolve(false);
			ws.onclose = () => resolve(false);
		});
		ws.onmessage = (e) => frames.push(String(e.data));
		return { opened, frames, ws };
	}

	test("ADV-WS-01/02/03/04/05 a full journey (+ cancel journey) publishes nothing managed on /ws or the observed API", async () => {
		const H = realHub();
		const taps = [
			await tap(H.base, "http://127.0.0.1:5999"),
			await tap(H.base, null),
			await tap(H.base, "http://127.0.0.1:6123"),
		];
		const c = await H.signIn();
		const g = await toGate2(c, H.fx);
		const v = await taskView(c, g.taskId);
		const req = v.approval_requests.find((r: any) => r.id === g.g2.id);
		const ch = await issueChallenge(c, req);
		expect((await decide(c, req, decisionBody(req, ch, "accept"))).status).toBe(
			201,
		);
		// cancel journey on a second task
		const b = await openGate1(c, H.fx);
		const bv = await taskView(c, b.taskId);
		expect(
			(await c.post(`/tasks/${b.taskId}/cancel`, { expected_rev: bv.task.rev }))
				.status,
		).toBe(200);
		// client-sent command frames are ignored
		const before = dump(H.db);
		for (const t of taps)
			if (t.opened)
				t.ws.send(
					JSON.stringify({
						action: "approve",
						approval_request_id: g.req.id,
						confirmation_text: "Edward",
					}),
				);
		await Bun.sleep(300);
		expect(dump(H.db)).toBe(before);
		const ids = new Set<string>();
		for (const t of [
			"workspace_tasks",
			"managed_proposals",
			"managed_approval_requests",
			"managed_decisions",
			"managed_tasks",
			"managed_runs",
			"managed_artifacts",
			"managed_reviews",
		])
			for (const r of rows(H.db, `SELECT id FROM ${t}`)) ids.add(r.id);
		for (const r of rows(H.db, "SELECT candidate_sha FROM managed_runs"))
			if (r.candidate_sha) ids.add(r.candidate_sha);
		ids.add(H.fx.dir);
		const all = taps.flatMap((t) => t.frames);
		// no telemetry was ingested during the journey → zero frames (no timing side channel)
		expect(all).toEqual([]);
		for (const t of taps) t.ws.close();
		expect(taps[0]?.opened).toBe(true);
		for (const p of [
			"/api/repos",
			"/api/sessions",
			"/api/events",
			"/healthz",
		]) {
			const r = await http(H.base, "GET", p);
			for (const id of ids)
				expect([p, r.text.includes(id)]).toEqual([p, false]);
		}
		// foreign-port socket (accepted by the observed /ws guard) learned nothing either
		void taps[2];
	});

	test("ADV-WS-06 no authenticated private channel exists (workspace data only via authenticated REST)", async () => {
		const H = realHub();
		const r = await http(H.base, "GET", `${BASE}/ws`, undefined, {
			cookie: null,
		});
		expect(r.status).toBe(401);
		void waitStage;
	});
});
