// N12: completed heartbeat gaps survive a hub restart. Every time is injected (no wall clock): the hub's
// receive clock is the only clock, the sender's `sent_at` is never read.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	HEARTBEAT_ONLINE_BELOW_MS,
	type Heartbeat,
	MachineView,
} from "@agent-city/schema";
import { MIGRATIONS_DIR } from "@agent-city/schema/migrations";
import { migrate, openDb } from "./db.ts";
import { createApp } from "./index.ts";
import { recordHeartbeat } from "./store.ts";

const T0 = Date.UTC(2026, 10, 20, 0, 0, 0);
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const DAY = 24 * 3_600_000;

interface GapRow {
	machine_id: string;
	from_at: string;
	until_at: string;
	boot_changed: number;
}

const gaps = (db: Database): GapRow[] =>
	db
		.query<GapRow, []>(
			"SELECT machine_id, from_at, until_at, boot_changed FROM machine_gaps ORDER BY machine_id, from_at",
		)
		.all();

/** A hub whose beats are posted at T0 + ms (the receive clock). */
function hub(db: Database = openDb(":memory:")) {
	const seqs: Record<string, number> = {};
	return {
		db,
		beat(
			ms: number,
			over: Partial<Heartbeat> & { machine_id?: Heartbeat["machine_id"] } = {},
		) {
			const machine_id = over.machine_id ?? "cockpit";
			const seq = over.seq ?? (seqs[machine_id] ?? -1) + 1;
			seqs[machine_id] = seq;
			return recordHeartbeat(
				db,
				{
					schema: 1,
					machine_id,
					boot_id: "boot-aaaa-0001",
					sent_at: new Date(0).toISOString(), // never read
					interval_s: 30,
					...over,
					seq,
				} as Heartbeat,
				new Date(T0 + ms),
			);
		},
	};
}

describe("machine_gaps: which completed gaps are stored", () => {
	test("89.999 s between accepted beats is no gap; 90 s is one, from the last receive to the return", () => {
		const h = hub();
		h.beat(0);
		h.beat(HEARTBEAT_ONLINE_BELOW_MS - 1);
		expect(gaps(h.db)).toEqual([]);
		const at = HEARTBEAT_ONLINE_BELOW_MS - 1;
		h.beat(at + HEARTBEAT_ONLINE_BELOW_MS);
		expect(gaps(h.db)).toEqual([
			{
				machine_id: "cockpit",
				from_at: iso(at),
				until_at: iso(at + HEARTBEAT_ONLINE_BELOW_MS),
				boot_changed: 0,
			},
		]);
	});

	test("the first beat ever is no gap, however late it comes", () => {
		const h = hub();
		h.beat(10 * DAY);
		expect(gaps(h.db)).toEqual([]);
	});

	test("a return with a new boot_id is a gap with boot_changed", () => {
		const h = hub();
		h.beat(0, { seq: 41 });
		h.beat(3_600_000, { boot_id: "boot-bbbb-0002", seq: 0 });
		expect(gaps(h.db)).toEqual([
			{
				machine_id: "cockpit",
				from_at: iso(0),
				until_at: iso(3_600_000),
				boot_changed: 1,
			},
		]);
	});

	test("a rejected beat (same boot, repeated or lower seq) records nothing, even after a long silence", () => {
		const h = hub();
		h.beat(0, { seq: 5 });
		expect(h.beat(600_000, { seq: 5 }).accepted).toBe(false);
		expect(h.beat(700_000, { seq: 4 }).accepted).toBe(false);
		expect(gaps(h.db)).toEqual([]);
		// the next accepted beat measures from the last ACCEPTED receive time
		h.beat(800_000, { seq: 6 });
		expect(gaps(h.db).map((g) => [g.from_at, g.until_at])).toEqual([
			[iso(0), iso(800_000)],
		]);
	});

	test("the hub clock going backwards records no gap (and no negative one)", () => {
		const h = hub();
		h.beat(1_000_000);
		h.beat(0); // the hub's clock was set back
		h.beat(30_000);
		expect(gaps(h.db)).toEqual([]);
	});

	test("each machine has its own gaps; a gap is never stored twice", () => {
		const h = hub();
		h.beat(0, { machine_id: "cockpit" });
		h.beat(0, { machine_id: "spine" });
		h.beat(200_000, { machine_id: "cockpit" });
		h.beat(200_000, { machine_id: "cockpit" }); // same receive time, next seq: 0 s apart
		h.beat(300_000, { machine_id: "spine" });
		expect(
			gaps(h.db).map((g) => [g.machine_id, g.from_at, g.until_at]),
		).toEqual([
			["cockpit", iso(0), iso(200_000)],
			["spine", iso(0), iso(300_000)],
		]);
	});

	test("gaps that ended more than 30 days ago are pruned when a new gap is written", () => {
		const h = hub();
		h.beat(0);
		h.beat(DAY); // gap A ends at 1 d
		h.beat(2 * DAY); // gap B ends at 2 d
		expect(gaps(h.db)).toHaveLength(2);
		// at 31 d + 1 ms: A (ended 1 d) is older than 30 days; B (ended 2 d) is not
		h.beat(31 * DAY + 1);
		expect(gaps(h.db).map((g) => g.until_at)).toEqual([
			iso(2 * DAY),
			iso(31 * DAY + 1),
		]);
	});

	test("a normal beat (no gap) does not prune", () => {
		const h = hub();
		h.beat(0);
		h.beat(DAY);
		let t = 40 * DAY;
		h.beat(t); // gap ends at 40 d: prunes the one ending at 1 d
		expect(gaps(h.db).map((g) => g.until_at)).toEqual([iso(40 * DAY)]);
		t += 30_000;
		h.beat(t);
		expect(gaps(h.db)).toHaveLength(1);
	});
});

describe("migration 009 on an existing hub DB", () => {
	test("version 8 → 9 keeps every row; migrating again changes nothing", () => {
		const db = new Database(":memory:", { strict: true });
		const files = readdirSync(MIGRATIONS_DIR)
			.filter((f) => /^\d+_.*\.sql$/.test(f))
			.sort();
		for (const f of files.filter((f) => Number.parseInt(f, 10) <= 8))
			db.run(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
		db.run("PRAGMA user_version = 8");
		db.run(
			`INSERT INTO machines (id, hostname, role, heartbeat_at, heartbeat_boot, heartbeat_seq, heartbeat_interval_s)
			 VALUES ('cockpit', 'mac', 'cockpit', '${iso(0)}', 'boot-aaaa-0001', 7, 30)`,
		);
		migrate(db);
		const version = () =>
			db.query<{ user_version: number }, []>("PRAGMA user_version").get()
				?.user_version;
		expect(version()).toBe(9);
		const row = () =>
			db
				.query<Record<string, unknown>, []>(
					"SELECT id, hostname, heartbeat_at, heartbeat_boot, heartbeat_seq FROM machines",
				)
				.all();
		const before = row();
		expect(before).toEqual([
			{
				id: "cockpit",
				hostname: "mac",
				heartbeat_at: iso(0),
				heartbeat_boot: "boot-aaaa-0001",
				heartbeat_seq: 7,
			},
		]);
		expect(gaps(db)).toEqual([]);
		migrate(db);
		expect(version()).toBe(9);
		expect(row()).toEqual(before);
		// the stored beat is the gap's start: the next accepted beat 2 h later is one gap
		hub(db).beat(7_200_000, { seq: 8 });
		expect(gaps(db).map((g) => [g.from_at, g.until_at])).toEqual([
			[iso(0), iso(7_200_000)],
		]);
	});

	test("the gap reads and the prune are served by indexes", () => {
		const db = openDb(":memory:");
		const plan = (sql: string) =>
			db
				.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`)
				.all()
				.map((r) => r.detail)
				.join(" | ");
		expect(
			plan(
				"SELECT * FROM machine_gaps WHERE machine_id = 'cockpit' AND until_at >= '2026' ORDER BY until_at DESC LIMIT 20",
			),
		).toMatch(/USING (COVERING )?INDEX/);
		expect(
			plan(
				"SELECT rowid FROM machine_gaps WHERE until_at < '2026' ORDER BY until_at LIMIT 64",
			),
		).toMatch(/USING (COVERING )?INDEX/);
	});
});

// ── 07: the same recent gaps over GET /api/machines and the `machine` message ──────────────────

const TOKEN = "test-ingest-token";

function appAt() {
	const db = openDb(":memory:");
	const published: { kind: string; data: unknown }[] = [];
	let clock = T0;
	const app = createApp({
		db,
		ingestToken: TOKEN,
		publish: (kind, data) => published.push({ kind, data }),
		now: () => new Date(clock),
	});
	let seq = 0;
	return {
		db,
		published,
		async beat(ms: number, machine_id: Heartbeat["machine_id"] = "cockpit") {
			clock = T0 + ms;
			const body = JSON.stringify({
				schema: 1,
				machine_id,
				boot_id: "boot-aaaa-0001",
				seq: seq++,
				sent_at: new Date(T0).toISOString(),
				interval_s: 30,
			});
			const res = await app.request("/ingest/heartbeat", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": String(new TextEncoder().encode(body).length),
					authorization: `Bearer ${TOKEN}`,
				},
				body,
			});
			expect(res.status).toBe(200);
		},
		async machines(ms: number): Promise<MachineView[]> {
			clock = T0 + ms;
			const res = await app.request("/api/machines");
			expect(res.status).toBe(200);
			return ((await res.json()) as { machines: MachineView[] }).machines;
		},
	};
}

const gapOf = (from: number, until: number, boot_changed = false) => ({
	from_at: iso(from),
	until_at: iso(until),
	boot_changed,
});

describe("recent_gaps over REST and WS", () => {
	test("every machine carries recent_gaps; never-heard and gapless ones have []", async () => {
		const a = appAt();
		const list = await a.machines(0);
		expect(list.map((m) => [m.id, m.recent_gaps])).toEqual([
			["cockpit", []],
			["forge", []],
			["spine", []],
		]);
		await a.beat(0, "spine");
		await a.beat(30_000, "spine");
		expect(
			(await a.machines(30_000)).find((m) => m.id === "spine")?.recent_gaps,
		).toEqual([]);
	});

	test("the returning beat's `machine` message and a later GET show the same gaps", async () => {
		const a = appAt();
		await a.beat(0);
		await a.beat(600_000);
		const sent = a.published.filter((p) => p.kind === "machine").at(-1)
			?.data as MachineView;
		expect(sent.recent_gaps).toEqual([gapOf(0, 600_000)]);
		const cockpit = (await a.machines(600_000)).find((m) => m.id === "cockpit");
		expect(cockpit).toEqual(sent);
		expect(MachineView.parse(sent)).toEqual(sent);
		// asking again gives the same answer
		expect((await a.machines(600_000)).find((m) => m.id === "cockpit")).toEqual(
			cockpit,
		);
	});

	test("only gaps that ended within the last 24 h, the newest 20, oldest first", async () => {
		const a = appAt();
		let t = 0;
		await a.beat(t);
		const ends: number[] = [];
		for (let i = 0; i < 25; i++) {
			t += 100_000; // each beat 100 s after the last: 25 gaps
			await a.beat(t);
			ends.push(t);
		}
		const gapsAt = async (ms: number) =>
			(await a.machines(ms)).find((m) => m.id === "cockpit")?.recent_gaps ?? [];
		const now = t;
		const got = await gapsAt(now);
		expect(got).toHaveLength(20);
		expect(got.map((g) => g.until_at)).toEqual(ends.slice(-20).map(iso));
		// the window: a gap ending exactly 24 h before `now` is in, 1 ms earlier is out
		const last = ends.at(-1) ?? 0;
		expect((await gapsAt(last + DAY)).map((g) => g.until_at)).toEqual([
			iso(last),
		]);
		expect(await gapsAt(last + DAY + 1)).toEqual([]);
	});

	test("forge with no history is still drawn (unobserved, [])", async () => {
		const a = appAt();
		await a.beat(0, "cockpit");
		await a.beat(500_000, "cockpit");
		const forge = (await a.machines(500_000)).find((m) => m.id === "forge");
		expect(forge).toEqual({
			id: "forge",
			hostname: null,
			heartbeat_at: null,
			interval_s: null,
			status: "unobserved",
			recent_gaps: [],
		});
	});
});

describe("MachineView.recent_gaps schema", () => {
	const base = {
		id: "cockpit" as const,
		hostname: null,
		heartbeat_at: iso(0),
		interval_s: 30,
		status: "online" as const,
	};
	test("an old hub's row without the field is still valid", () => {
		expect(MachineView.safeParse(base).success).toBe(true);
	});
	test("ordered, at most 20, each from_at before until_at", () => {
		const ok = Array.from({ length: 20 }, (_, i) =>
			gapOf(i * 200_000, i * 200_000 + 100_000),
		);
		expect(MachineView.safeParse({ ...base, recent_gaps: ok }).success).toBe(
			true,
		);
		const tooMany = [...ok, gapOf(5_000_000, 5_100_000)];
		expect(
			MachineView.safeParse({ ...base, recent_gaps: tooMany }).success,
		).toBe(false);
		const unordered = [gapOf(300_000, 400_000), gapOf(0, 100_000)];
		expect(
			MachineView.safeParse({ ...base, recent_gaps: unordered }).success,
		).toBe(false);
		const backwards = [gapOf(100_000, 0)];
		expect(
			MachineView.safeParse({ ...base, recent_gaps: backwards }).success,
		).toBe(false);
	});
});
