import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { RUNS_MAX_BODY_BYTES, type RunView } from "@agent-city/schema";
import { openDb } from "./db.ts";
import { createApp } from "./index.ts";
import type { BroadcastKind } from "./routes/ws.ts";

const OFFICE = "test-office-projection-token";
const INGEST = "test-ingest-token";
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const iso = (ms: number) => new Date(T0 + ms).toISOString();

interface Ctx {
	db: Database;
	app: ReturnType<typeof createApp>;
	published: { kind: BroadcastKind; data: unknown }[];
	at: (ms: number) => void;
}

function setup(
	tokens: { office?: string | null; ingest?: string | null } = {},
): Ctx {
	const db = openDb(":memory:");
	const published: Ctx["published"] = [];
	let clock = T0;
	const office = tokens.office === undefined ? OFFICE : tokens.office;
	const ingest = tokens.ingest === undefined ? INGEST : tokens.ingest;
	const app = createApp({
		db,
		ingestToken: ingest ?? undefined,
		officeToken: office ?? undefined,
		publish: (kind, data) => published.push({ kind, data }),
		now: () => new Date(clock),
	});
	return {
		db,
		app,
		published,
		at: (ms) => {
			clock = T0 + ms;
		},
	};
}

const run = (over: Record<string, unknown> = {}) => ({
	run_id: "station0-notes-2",
	project: "EdwardH-jedi/station0",
	workflow_id: "station0-validation-notes",
	phase: "QA",
	status: "RUNNING",
	reason: "RECORDER_CHECK_RUNNING",
	alert: null,
	last_progress_at: iso(0),
	idle_seconds: 48,
	completed: [],
	tokens_today: 18125,
	usage_unknown: false,
	evidence_verified: true,
	last_event_sequence: 7,
	events: [
		{ sequence: 7, transition: "task.started", task_id: "T1", attempt: 1 },
	],
	...over,
});

const payload = (over: Record<string, unknown> = {}, runs = [run()]) => ({
	schema: 1,
	source: "agent-office",
	machine_id: "cockpit",
	observed_at: iso(0),
	ledger_revision: 42,
	runs,
	...over,
});

function post(
	_ctx: Ctx,
	body: unknown,
	auth: string | null = `Bearer ${OFFICE}`,
	path = "/ingest/runs",
	target: Ctx = _ctx,
): Promise<Response> {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"content-length": String(new TextEncoder().encode(text).length),
	};
	if (auth !== null) headers.authorization = auth;
	return Promise.resolve(
		target.app.request(path, { method: "POST", headers, body: text }),
	);
}

async function runs(ctx: Ctx): Promise<RunView[]> {
	const res = await ctx.app.request("/api/runs");
	expect(res.status).toBe(200);
	return ((await res.json()) as { runs: RunView[] }).runs;
}

const count = (ctx: Ctx, table: string) =>
	ctx.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()
		?.n;

let ctx: Ctx;
beforeEach(() => {
	ctx = setup();
});

describe("POST /ingest/runs — who may post", () => {
	test("no OFFICE_PROJECTION_TOKEN configured → 503", async () => {
		const c = setup({ office: null });
		expect((await post(c, payload())).status).toBe(503);
	});

	test("missing or wrong token → 401, nothing stored", async () => {
		expect((await post(ctx, payload(), null)).status).toBe(401);
		expect((await post(ctx, payload(), "Bearer nope")).status).toBe(401);
		expect(count(ctx, "runs")).toBe(0);
	});

	test("the collector INGEST_TOKEN cannot post run state", async () => {
		const res = await post(ctx, payload(), `Bearer ${INGEST}`);
		expect(res.status).toBe(401);
		expect(count(ctx, "runs")).toBe(0);
	});

	test("the office token does not open /ingest or /ingest/heartbeat either", async () => {
		const ev = {
			id: "e1",
			ts: iso(0),
			machine_id: "cockpit",
			session_id: "s1",
			provider: "claude",
			type: "PreToolUse",
		};
		expect((await post(ctx, ev, `Bearer ${OFFICE}`, "/ingest")).status).toBe(
			401,
		);
		expect(
			(await post(ctx, { schema: 1 }, `Bearer ${OFFICE}`, "/ingest/heartbeat"))
				.status,
		).toBe(401);
	});

	test("the same value for both tokens leaves the run route disabled", async () => {
		const c = setup({ office: INGEST, ingest: INGEST });
		expect((await post(c, payload(), `Bearer ${INGEST}`)).status).toBe(503);
		const health = (await (await c.app.request("/healthz")).json()) as Record<
			string,
			unknown
		>;
		expect(health.run_projection).toBe("disabled");
	});

	test("a well-formed report from forge or spine is refused (403) and stores nothing", async () => {
		for (const machine_id of ["forge", "spine"]) {
			expect((await post(ctx, payload({ machine_id }))).status).toBe(403);
		}
		expect(count(ctx, "runs")).toBe(0);
	});

	test("an unknown machine is a plain 400", async () => {
		expect((await post(ctx, payload({ machine_id: "laptop" }))).status).toBe(
			400,
		);
	});
});

describe("POST /ingest/runs — what may be posted", () => {
	test("forbidden fields are a 400 and are never echoed", async () => {
		const goal = "Document the validation workflow for the owner";
		const res = await post(ctx, payload({ goal }));
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).not.toContain(goal);
		expect(text).not.toContain('"goal"');
		expect((await post(ctx, payload({}, [run({ goal })]))).status).toBe(400);
		expect(
			(await post(ctx, payload({}, [run({ evidence: "x" })]))).status,
		).toBe(400);
	});

	test("the NAME of an unknown key is not reflected either", async () => {
		const name = `sk-ant-${"z".repeat(30)}`;
		const res = await post(ctx, payload({ [name]: 1 }));
		expect(res.status).toBe(400);
		expect(await res.text()).not.toContain(name);
	});

	test("a path-shaped value anywhere is a 400", async () => {
		for (const bad of ["/Users/someone/project", "C:\\dev\\x", "a/b/c"]) {
			expect(
				(await post(ctx, payload({}, [run({ reason: bad })]))).status,
			).toBe(400);
			expect(
				(await post(ctx, payload({}, [run({ run_id: bad })]))).status,
			).toBe(400);
		}
		expect(
			(await post(ctx, payload({}, [run({ project: "/Users/someone/x" })])))
				.status,
		).toBe(400);
		expect(count(ctx, "runs")).toBe(0);
	});

	test("leak-shaped phase / project / reason are a 400 that does not echo the value", async () => {
		const key = "aZ9".repeat(10); // random-looking, no vendor prefix
		for (const over of [
			{ phase: `Bearer ${key}` },
			{ phase: "Bearer x" },
			{ phase: "Delete Files" },
			{ phase: "Delete Every File" },
			{ project: ".ssh/id_rsa" },
			{ project: `.ssh/${key}` },
			{ project: "a/b/c" },
			{ reason: key },
		]) {
			const res = await post(ctx, payload({}, [run(over)]));
			expect(res.status).toBe(400);
			const text = await res.text();
			for (const v of Object.values(over)) expect(text).not.toContain(v);
			expect(text).not.toContain(key);
		}
		expect(count(ctx, "runs")).toBe(0);
	});

	test("every Office phase and real GitHub repo names are accepted; a two-run report is stored in full", async () => {
		const phases = [
			"Goal",
			"Plan",
			"Approval",
			"Implementation",
			"QA",
			"Independent Review",
			"Integration",
			"Cleanup",
			"Report",
		];
		const res = await post(
			ctx,
			payload(
				{},
				phases.map((phase, i) =>
					run({
						run_id: `run-${i}`,
						phase,
						project: [
							"alpha/.github",
							"alpha/observabilityplatform2026",
							"EdwardH-jedi/station0",
						][i % 3],
					}),
				),
			),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ applied: 9, ignored: 0 });
		expect(count(ctx, "runs")).toBe(9);
		const two = await post(
			ctx,
			payload({ ledger_revision: 43 }, [
				run({ run_id: "station0-rule-engine-tests-1" }),
				run({ run_id: "nwc-m1", project: "alpha/.github" }),
			]),
		);
		expect(two.status).toBe(200);
		expect(await two.json()).toEqual({ applied: 2, ignored: 0 });
		const stored = await runs(ctx);
		expect(stored.find((r) => r.run_id === "nwc-m1")?.project).toBe(
			"alpha/.github",
		);
		expect(
			stored.find((r) => r.run_id === "station0-rule-engine-tests-1")?.project,
		).toBe("EdwardH-jedi/station0");
	});

	test("invalid JSON → 400; a body over the cap → 413", async () => {
		expect((await post(ctx, "{nope")).status).toBe(400);
		const big = payload({ pad: "x".repeat(RUNS_MAX_BODY_BYTES + 1) });
		expect((await post(ctx, big)).status).toBe(413);
	});

	test("the DB never holds a path, token or prompt after accepted reports", async () => {
		await post(ctx, payload());
		const dump = JSON.stringify([
			ctx.db.query("SELECT * FROM runs").all(),
			ctx.db.query("SELECT * FROM run_events").all(),
		]);
		expect(dump).not.toContain("/Users/");
		expect(dump).not.toContain(OFFICE);
		expect(dump).not.toContain(INGEST);
	});
});

describe("storage, order and idempotency", () => {
	test("a report is stored and shown as running, with the hub's receive time", async () => {
		const res = await post(ctx, payload());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ applied: 1, ignored: 0 });
		const [r] = await runs(ctx);
		expect(r?.display).toBe("running");
		expect(r?.reported_at).toBe(iso(0));
		expect(r?.run_id).toBe("station0-notes-2");
		expect(r?.project).toBe("EdwardH-jedi/station0");
		expect(r?.needs_owner).toBe(false);
	});

	test("a resend is harmless: one run row, one event row; the receive time refreshes", async () => {
		await post(ctx, payload());
		ctx.at(10_000);
		await post(ctx, payload({ observed_at: iso(10_000) }));
		expect(count(ctx, "runs")).toBe(1);
		expect(count(ctx, "run_events")).toBe(1);
		expect((await runs(ctx))[0]?.reported_at).toBe(iso(10_000));
	});

	test("an older ledger_revision is ignored and changes nothing, not even the receive time", async () => {
		await post(
			ctx,
			payload({ ledger_revision: 50 }, [
				run({ status: "HOLD", reason: "MODEL_CHAIN_EXHAUSTED" }),
			]),
		);
		ctx.at(20_000);
		const res = await post(
			ctx,
			payload({ ledger_revision: 49, observed_at: iso(20_000) }, [
				run({ status: "RUNNING" }),
			]),
		);
		expect(await res.json()).toEqual({ applied: 0, ignored: 1 });
		const [r] = await runs(ctx);
		expect(r?.status).toBe("HOLD");
		expect(r?.reported_at).toBe(iso(0));
	});

	test("same revision: a lower last_event_sequence is ignored, a higher one applies", async () => {
		await post(ctx, payload({}, [run({ last_event_sequence: 7 })]));
		ctx.at(5_000);
		const lower = await post(
			ctx,
			payload({ observed_at: iso(5_000) }, [
				run({ last_event_sequence: 6, phase: "Plan" }),
			]),
		);
		expect(await lower.json()).toEqual({ applied: 0, ignored: 1 });
		const higher = await post(
			ctx,
			payload({ observed_at: iso(5_000) }, [
				run({ last_event_sequence: 8, phase: "Report" }),
			]),
		);
		expect(await higher.json()).toEqual({ applied: 1, ignored: 0 });
		expect((await runs(ctx))[0]?.phase).toBe("Report");
	});

	test("same position: a newer observed_at applies (an idle alert has no ledger event), an older one is ignored", async () => {
		await post(ctx, payload({ observed_at: iso(10_000) }));
		ctx.at(20_000);
		const alert = await post(
			ctx,
			payload({ observed_at: iso(20_000) }, [run({ alert: "STALE_OR_IDLE" })]),
		);
		expect(await alert.json()).toEqual({ applied: 1, ignored: 0 });
		expect((await runs(ctx))[0]?.display).toBe("no_progress_suspected");
		const old = await post(
			ctx,
			payload({ observed_at: iso(15_000) }, [run({ alert: null })]),
		);
		expect(await old.json()).toEqual({ applied: 0, ignored: 1 });
		expect((await runs(ctx))[0]?.display).toBe("no_progress_suspected");
	});

	test("same position and the same observed_at: ignored even with different content; received_at is not refreshed", async () => {
		await post(ctx, payload({ observed_at: iso(0) }));
		ctx.at(120_000); // no report for 2 min → snapshot_stale
		expect((await runs(ctx))[0]?.display).toBe("snapshot_stale");
		const before = ctx.published.length;
		const replay = await post(
			ctx,
			payload({ observed_at: iso(0) }, [run({ alert: "STALE_OR_IDLE" })]),
		);
		expect(await replay.json()).toEqual({ applied: 0, ignored: 1 });
		const [r] = await runs(ctx);
		expect(r?.reported_at).toBe(iso(0));
		expect(r?.alert).toBeNull();
		expect(r?.display).toBe("snapshot_stale");
		expect(ctx.published.length).toBe(before);
		// an identical resend is ignored the same way
		const resend = await post(ctx, payload({ observed_at: iso(0) }));
		expect(await resend.json()).toEqual({ applied: 0, ignored: 1 });
		expect((await runs(ctx))[0]?.reported_at).toBe(iso(0));
	});

	test("observed_at is compared below the millisecond and across offsets", async () => {
		const at = (frac: string, off = "Z") => `2026-01-01T00:00:00.${frac}${off}`;
		await post(
			ctx,
			payload({ observed_at: at("000500") }, [run({ phase: "Report" })]),
		);
		ctx.at(1_000);
		// 0.0004 s is older than 0.0005 s although Date.parse sees the same millisecond
		const older = await post(
			ctx,
			payload({ observed_at: at("0004") }, [run({ phase: "Plan" })]),
		);
		expect(await older.json()).toEqual({ applied: 0, ignored: 1 });
		expect((await runs(ctx))[0]?.phase).toBe("Report");
		// the same instant written with another offset is equal → ignored
		const same = await post(
			ctx,
			payload({ observed_at: "2026-01-01T10:00:00.0005+10:00" }, [
				run({ phase: "Plan" }),
			]),
		);
		expect(await same.json()).toEqual({ applied: 0, ignored: 1 });
		const newer = await post(
			ctx,
			payload({ observed_at: at("00051") }, [run({ phase: "Integration" })]),
		);
		expect(await newer.json()).toEqual({ applied: 1, ignored: 0 });
		const [r] = await runs(ctx);
		expect(r?.phase).toBe("Integration");
		expect(r?.observed_at).toBe(at("00051"));
		expect(r?.reported_at).toBe(iso(1_000));
	});

	test("events are unique per (machine, run, sequence) and arrive in any order", async () => {
		const ev = (n: number) => ({ sequence: n, transition: "task.started" });
		await post(
			ctx,
			payload({}, [
				run({ last_event_sequence: 9, events: [ev(9), ev(7), ev(8)] }),
			]),
		);
		ctx.at(1_000);
		await post(
			ctx,
			payload({ observed_at: iso(1_000) }, [
				run({ last_event_sequence: 9, events: [ev(7), ev(8), ev(9)] }),
			]),
		);
		expect(count(ctx, "run_events")).toBe(3);
		const res = await ctx.app.request(
			"/api/runs/cockpit/station0-notes-2/events",
		);
		const { events } = (await res.json()) as { events: { sequence: number }[] };
		expect(events.map((e) => e.sequence)).toEqual([9, 8, 7]);
	});

	test("events endpoint: unknown machine → 400; bad limit → 400", async () => {
		expect((await ctx.app.request("/api/runs/laptop/x/events")).status).toBe(
			400,
		);
		expect(
			(await ctx.app.request("/api/runs/cockpit/x/events?limit=0")).status,
		).toBe(400);
	});
});

describe("state vocabulary over time", () => {
	const step = async (
		c: Ctx,
		ms: number,
		rev: number,
		over: Record<string, unknown>,
	) => {
		c.at(ms);
		await post(
			c,
			payload({ ledger_revision: rev, observed_at: iso(ms) }, [
				run({ last_event_sequence: rev, ...over }),
			]),
		);
		return (await runs(c))[0];
	};

	test("running → no_progress_suspected → hold → passed", async () => {
		expect((await step(ctx, 0, 1, {}))?.display).toBe("running");
		expect(
			(await step(ctx, 30_000, 1, { alert: "STALE_OR_IDLE" }))?.display,
		).toBe("no_progress_suspected");
		const hold = await step(ctx, 60_000, 2, {
			status: "HOLD",
			reason: "RUNNING_AGENTS_OR_OPEN_FILES",
			alert: "RUNNING_AGENTS_OR_OPEN_FILES", // the real Office watchdog sets alert = reason on a HOLD
		});
		expect(hold?.display).toBe("hold");
		expect(hold?.needs_owner).toBe(true);
		const pass = await step(ctx, 90_000, 3, {
			status: "PASS",
			reason: "WORKTREE_RETAINED",
			phase: "Report",
		});
		expect(pass?.display).toBe("passed");
		expect(pass?.needs_owner).toBe(false);
	});

	test("waiting_owner, needs_reconcile and unverified", async () => {
		const w = await step(ctx, 0, 1, {
			status: "READY",
			reason: "AWAITING_PLAN_APPROVAL",
		});
		expect(w?.display).toBe("waiting_owner");
		expect(w?.needs_owner).toBe(true);
		const r = await step(ctx, 1_000, 2, { alert: "FAILED_PROCESS_RECONCILE" });
		expect(r?.display).toBe("needs_reconcile");
		const u = await step(ctx, 2_000, 3, {
			status: "PASS",
			evidence_verified: false,
		});
		expect(u?.display).toBe("unverified");
	});

	test("90 s without a new report → snapshot_stale, remembering what was last reported", async () => {
		await step(ctx, 0, 1, {});
		ctx.at(89_000);
		expect((await runs(ctx))[0]?.display).toBe("running");
		ctx.at(90_000);
		const r = (await runs(ctx))[0];
		expect(r?.display).toBe("snapshot_stale");
		expect(r?.last_display).toBe("running");
	});

	test("an offline cockpit turns a freshly reported run into snapshot_stale", async () => {
		// the cockpit beat once at T0 and then went quiet; reports kept arriving until T0+590 s
		await ctx.app.request("/ingest/heartbeat", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${INGEST}`,
			},
			body: JSON.stringify({
				schema: 1,
				machine_id: "cockpit",
				boot_id: "boot-aaaa-0001",
				seq: 0,
				sent_at: iso(0),
				interval_s: 30,
			}),
		});
		await step(ctx, 590_000, 1, {});
		ctx.at(595_000);
		expect((await runs(ctx))[0]?.display).toBe("running");
		ctx.at(600_000); // heartbeat is now 10 min old → machine offline; the report is only 10 s old
		expect((await runs(ctx))[0]?.display).toBe("snapshot_stale");
	});

	test("a passed run stays passed when the report ages", async () => {
		await step(ctx, 0, 1, { status: "PASS", phase: "Report" });
		ctx.at(3_600_000);
		expect((await runs(ctx))[0]?.display).toBe("passed");
	});
});

describe("broadcast and no actions", () => {
	test("publishes a `run` message for an applied report, none for an ignored one", async () => {
		await post(ctx, payload({ ledger_revision: 5 }));
		await post(ctx, payload({ ledger_revision: 4 }));
		const msgs = ctx.published.filter((p) => p.kind === "run");
		expect(msgs).toHaveLength(1);
		const sent = msgs[0]?.data as RunView;
		expect(sent.display).toBe("running");
	});

	test("City has no route that acts: write methods and action paths are not routes", async () => {
		for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
			const res = await ctx.app.request("/api/runs", { method });
			expect(res.status).toBe(404);
		}
		for (const p of [
			"/api/runs/cockpit/x/approve",
			"/api/runs/cockpit/x/retry",
			"/api/runs/cockpit/x/launch",
		]) {
			expect((await ctx.app.request(p, { method: "POST" })).status).toBe(404);
		}
	});

	test("existing session ingest and machines API are unaffected", async () => {
		const res = await ctx.app.request("/ingest", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${INGEST}`,
			},
			body: JSON.stringify({
				id: "r-e1",
				ts: iso(0),
				machine_id: "cockpit",
				session_id: "s1",
				provider: "claude",
				type: "PreToolUse",
			}),
		});
		expect(res.status).toBe(200);
		expect((await ctx.app.request("/api/machines")).status).toBe(200);
	});
});
