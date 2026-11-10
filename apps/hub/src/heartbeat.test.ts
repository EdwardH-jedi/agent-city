import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { HEARTBEAT_MAX_BODY_BYTES, type MachineView } from "@agent-city/schema";
import { openDb } from "./db.ts";
import { createApp } from "./index.ts";
import type { BroadcastKind } from "./routes/ws.ts";
import { listMachines, recordHeartbeat } from "./store.ts";

const TOKEN = "test-ingest-token";
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

interface Ctx {
	db: Database;
	app: ReturnType<typeof createApp>;
	published: { kind: BroadcastKind; data: unknown }[];
	/** Move the hub's clock to T0 + ms. */
	at: (ms: number) => void;
}

function setup(token: string | null = TOKEN): Ctx {
	const db = openDb(":memory:");
	const published: Ctx["published"] = [];
	let clock = T0;
	const app = createApp({
		db,
		ingestToken: token ?? undefined,
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

const beat = (over: Record<string, unknown> = {}) => ({
	schema: 1,
	machine_id: "spine",
	boot_id: "boot-aaaa-0001",
	seq: 0,
	sent_at: new Date(T0).toISOString(),
	interval_s: 30,
	...over,
});

function postBeat(
	ctx: Ctx,
	body: unknown,
	auth: string | null = `Bearer ${TOKEN}`,
): Promise<Response> {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"content-length": String(new TextEncoder().encode(text).length),
	};
	if (auth !== null) headers.authorization = auth;
	return Promise.resolve(
		ctx.app.request("/ingest/heartbeat", {
			method: "POST",
			headers,
			body: text,
		}),
	);
}

async function machines(ctx: Ctx): Promise<Record<string, MachineView>> {
	const res = await ctx.app.request("/api/machines");
	expect(res.status).toBe(200);
	const { machines: list } = (await res.json()) as { machines: MachineView[] };
	return Object.fromEntries(list.map((m) => [m.id, m]));
}

let ctx: Ctx;
beforeEach(() => {
	ctx = setup();
});

describe("POST /ingest/heartbeat — auth, shape, size", () => {
	test("no INGEST_TOKEN configured → 503", async () => {
		const c = setup(null);
		expect((await postBeat(c, beat())).status).toBe(503);
	});

	test("missing or wrong bearer token → 401, and nothing is stored", async () => {
		expect((await postBeat(ctx, beat(), null)).status).toBe(401);
		expect((await postBeat(ctx, beat(), "Bearer nope")).status).toBe(401);
		expect((await machines(ctx)).spine?.status).toBe("unobserved");
	});

	test("a machine outside cockpit / forge / spine → 400", async () => {
		for (const machine_id of ["laptop", "rtx", "COCKPIT"]) {
			expect((await postBeat(ctx, beat({ machine_id }))).status).toBe(400);
		}
	});

	test("an extra key → 400 (no path, command or prompt can be carried)", async () => {
		const res = await postBeat(ctx, beat({ cwd: "/Users/someone/project" }));
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).not.toContain("/Users/someone"); // the body is never echoed
	});

	test("invalid JSON → 400; wrong field types → 400", async () => {
		expect((await postBeat(ctx, "{not json")).status).toBe(400);
		expect((await postBeat(ctx, beat({ seq: "1" }))).status).toBe(400);
		expect((await postBeat(ctx, beat({ interval_s: 1 }))).status).toBe(400);
		expect((await postBeat(ctx, beat({ boot_id: "x" }))).status).toBe(400);
	});

	test("a body over 4 KiB → 413", async () => {
		const big = beat({ pad: "x".repeat(HEARTBEAT_MAX_BODY_BYTES + 1) });
		expect((await postBeat(ctx, big)).status).toBe(413);
		expect((await machines(ctx)).spine?.status).toBe("unobserved");
	});

	test("a normal beat is accepted", async () => {
		const res = await postBeat(ctx, beat());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ accepted: true });
	});
});

describe("GET /api/machines", () => {
	test("always returns the three machines; never-heard ones are unobserved", async () => {
		const res = await ctx.app.request("/api/machines");
		const { machines: list } = (await res.json()) as {
			machines: MachineView[];
		};
		expect(list.map((m) => m.id)).toEqual(["cockpit", "forge", "spine"]);
		for (const m of list) {
			expect(m.status).toBe("unobserved");
			expect(m.heartbeat_at).toBeNull();
			expect(m.interval_s).toBeNull();
		}
	});

	test("after a beat only that machine is online; forge stays unobserved", async () => {
		await postBeat(ctx, beat({ machine_id: "spine", hostname: "rx" }));
		const m = await machines(ctx);
		expect(m.spine?.status).toBe("online");
		expect(m.spine?.hostname).toBe("rx");
		expect(m.spine?.heartbeat_at).toBe(new Date(T0).toISOString());
		expect(m.spine?.interval_s).toBe(30);
		expect(m.cockpit?.status).toBe("unobserved");
		expect(m.forge?.status).toBe("unobserved");
	});
});

describe("liveness boundaries use the hub's receive clock", () => {
	test("89 s online · 90 s stale · 599 s stale · 600 s offline", async () => {
		await postBeat(ctx, beat());
		const expected: [number, MachineView["status"]][] = [
			[89_000, "online"],
			[90_000, "stale"],
			[599_000, "stale"],
			[600_000, "offline"],
		];
		for (const [ms, status] of expected) {
			ctx.at(ms);
			expect((await machines(ctx)).spine?.status).toBe(status);
		}
	});

	test("the sender's clock is ignored: a sent_at far in the past or future changes nothing", async () => {
		await postBeat(ctx, beat({ sent_at: "2000-01-01T00:00:00.000Z" }));
		expect((await machines(ctx)).spine?.status).toBe("online");
		const c = setup();
		await postBeat(c, beat({ sent_at: "2999-01-01T00:00:00.000Z" }));
		c.at(600_000);
		expect((await machines(c)).spine?.status).toBe("offline");
	});

	test("a machine that went quiet comes back online with its next beat", async () => {
		await postBeat(ctx, beat({ seq: 0 }));
		ctx.at(20 * 60_000);
		expect((await machines(ctx)).spine?.status).toBe("offline");
		await postBeat(ctx, beat({ seq: 1 }));
		expect((await machines(ctx)).spine?.status).toBe("online");
	});
});

describe("duplicate, out-of-order and restart", () => {
	test("same boot_id, seq not increasing → accepted:false and nothing changes", async () => {
		await postBeat(ctx, beat({ seq: 5 }));
		ctx.at(30_000);
		const dup = await postBeat(ctx, beat({ seq: 5 }));
		expect(dup.status).toBe(200);
		expect(await dup.json()).toEqual({ accepted: false });
		const older = await postBeat(ctx, beat({ seq: 2 }));
		expect(await older.json()).toEqual({ accepted: false });
		// still the receive time of seq 5, not of the replays
		expect((await machines(ctx)).spine?.heartbeat_at).toBe(
			new Date(T0).toISOString(),
		);
	});

	test("a higher seq of the same boot updates the receive time", async () => {
		await postBeat(ctx, beat({ seq: 5 }));
		ctx.at(30_000);
		expect(await (await postBeat(ctx, beat({ seq: 6 }))).json()).toEqual({
			accepted: true,
		});
		expect((await machines(ctx)).spine?.heartbeat_at).toBe(
			new Date(T0 + 30_000).toISOString(),
		);
	});

	test("a new boot_id is a restart and is accepted even with a lower seq", async () => {
		await postBeat(ctx, beat({ boot_id: "boot-aaaa-0001", seq: 50 }));
		ctx.at(10_000);
		const res = await postBeat(
			ctx,
			beat({ boot_id: "boot-bbbb-0002", seq: 0 }),
		);
		expect(await res.json()).toEqual({ accepted: true });
		// and the new boot continues from its own counter
		expect(
			await (
				await postBeat(ctx, beat({ boot_id: "boot-bbbb-0002", seq: 0 }))
			).json(),
		).toEqual({ accepted: false });
	});
});

describe("broadcast and storage", () => {
	test("publishes a `machine` message only for an accepted beat", async () => {
		await postBeat(ctx, beat({ seq: 0 }));
		await postBeat(ctx, beat({ seq: 0 })); // duplicate
		const machine = ctx.published.filter((p) => p.kind === "machine");
		expect(machine).toHaveLength(1);
		const sent = machine[0]?.data as MachineView;
		expect(sent.id).toBe("spine");
		expect(sent.status).toBe("online");
	});

	test("hostname is redacted like every other collector string", () => {
		const secret = `ghp_${"a".repeat(36)}`;
		recordHeartbeat(
			ctx.db,
			{
				schema: 1,
				machine_id: "forge",
				hostname: secret,
				boot_id: "boot-cccc-0003",
				seq: 0,
				sent_at: new Date(T0).toISOString(),
				interval_s: 30,
			},
			new Date(T0),
		);
		const forge = listMachines(ctx.db, new Date(T0)).find(
			(m) => m.id === "forge",
		);
		expect(forge?.hostname).not.toContain(secret);
	});
});

describe("existing ingest is unaffected", () => {
	const ev = (over: Record<string, unknown> = {}) => ({
		id: "hb-e1",
		ts: new Date(T0).toISOString(),
		machine_id: "cockpit",
		session_id: "s1",
		provider: "claude",
		type: "PreToolUse",
		...over,
	});
	const postEvent = (c: Ctx, body: unknown) =>
		c.app.request("/ingest", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${TOKEN}`,
			},
			body: JSON.stringify(body),
		});

	test("session events still ingest, and an event does not make a machine online", async () => {
		const res = await postEvent(ctx, ev());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ accepted: 1, duplicates: 0 });
		expect((await machines(ctx)).cockpit?.status).toBe("unobserved");
	});

	test("a heartbeat leaves last_seen_at (the event clock) alone", async () => {
		await postEvent(ctx, ev());
		const read = () =>
			ctx.db
				.query<{ last_seen_at: string | null }, []>(
					"SELECT last_seen_at FROM machines WHERE id = 'cockpit'",
				)
				.get();
		const before = read();
		ctx.at(45_000);
		await postBeat(ctx, beat({ machine_id: "cockpit" }));
		expect(read()?.last_seen_at).toBe(before?.last_seen_at ?? null);
		expect(before?.last_seen_at).not.toBeNull();
		expect((await machines(ctx)).cockpit?.status).toBe("online");
	});

	test("an event after a heartbeat keeps the heartbeat columns", async () => {
		await postBeat(ctx, beat({ machine_id: "cockpit" }));
		await postEvent(ctx, ev({ id: "hb-e2" }));
		const m = (await machines(ctx)).cockpit;
		expect(m?.status).toBe("online");
		expect(m?.heartbeat_at).toBe(new Date(T0).toISOString());
	});
});
