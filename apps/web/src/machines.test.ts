import { describe, expect, test } from "bun:test";
import type { MachineView } from "@agent-city/schema";
import { machinesAt, mergeMachines, parseHubMessage } from "./merge.ts";

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const iso = (ms: number) => new Date(T0 + ms).toISOString();

const view = (
	id: MachineView["id"],
	beatMs: number | null,
	status: MachineView["status"] = "online",
): MachineView => ({
	id,
	hostname: null,
	heartbeat_at: beatMs === null ? null : iso(beatMs),
	interval_s: beatMs === null ? null : 30,
	status,
});

describe("mergeMachines", () => {
	test("keeps cockpit, forge, spine order whatever arrives first", () => {
		const out = mergeMachines([], [view("spine", 0), view("cockpit", 0)]);
		expect(out.map((m) => m.id)).toEqual(["cockpit", "spine"]);
		const all = mergeMachines(out, [view("forge", null, "unobserved")]);
		expect(all.map((m) => m.id)).toEqual(["cockpit", "forge", "spine"]);
	});

	test("a newer heartbeat replaces an older one", () => {
		const out = mergeMachines([view("spine", 0)], [view("spine", 30_000)]);
		expect(out[0]?.heartbeat_at).toBe(iso(30_000));
	});

	test("an older snapshot never replaces a newer live beat", () => {
		const out = mergeMachines([view("spine", 60_000)], [view("spine", 0)]);
		expect(out[0]?.heartbeat_at).toBe(iso(60_000));
	});

	test("an `unobserved` row does not wipe a machine we have already seen beat", () => {
		const out = mergeMachines(
			[view("spine", 60_000)],
			[view("spine", null, "unobserved")],
		);
		expect(out[0]?.status).toBe("online");
		expect(out[0]?.heartbeat_at).toBe(iso(60_000));
	});
});

describe("machinesAt — the screen's own clock decides", () => {
	test("online → stale → offline with no new message, at the 90 s and 600 s edges", () => {
		const m = [view("spine", 0)];
		const status = (ms: number) => machinesAt(m, T0 + ms)[0]?.status;
		expect(status(89_000)).toBe("online");
		expect(status(90_000)).toBe("stale");
		expect(status(599_000)).toBe("stale");
		expect(status(600_000)).toBe("offline");
	});

	test("a machine never heard from stays unobserved", () => {
		expect(machinesAt([view("forge", null, "unobserved")], T0)[0]?.status).toBe(
			"unobserved",
		);
	});

	test("does not mutate its input", () => {
		const m = [view("spine", 0, "online")];
		machinesAt(m, T0 + 700_000);
		expect(m[0]?.status).toBe("online");
	});
});

describe("parseHubMessage", () => {
	test("accepts a machine frame", () => {
		const frame = JSON.stringify({ kind: "machine", data: view("spine", 0) });
		const msg = parseHubMessage(frame);
		expect(msg?.kind).toBe("machine");
	});

	test("still rejects unknown kinds and garbage", () => {
		expect(
			parseHubMessage(JSON.stringify({ kind: "nope", data: {} })),
		).toBeNull();
		expect(parseHubMessage("{not json")).toBeNull();
	});
});

// ── N12: recent_gaps through snapshot and ws, in either order ───────────────────────────────────

const gap = (from: number, until: number, boot_changed = false) => ({
	from_at: iso(from),
	until_at: iso(until),
	boot_changed,
});
const withGaps = (
	m: MachineView,
	gaps: MachineView["recent_gaps"],
): MachineView => ({ ...m, recent_gaps: gaps });
const DAY = 24 * 3_600_000;

describe("mergeMachines — recent_gaps", () => {
	const G = gap(0, 600_000);

	test("snapshot → ws: the returning beat's gaps arrive", () => {
		const snap = mergeMachines([], [withGaps(view("cockpit", 0), [])]);
		const out = mergeMachines(snap, [withGaps(view("cockpit", 600_000), [G])]);
		expect(out[0]?.recent_gaps).toEqual([G]);
		expect(out[0]?.heartbeat_at).toBe(iso(600_000));
	});

	test("ws → late snapshot (older heartbeat): the newer beat and its gaps stay", () => {
		const live = mergeMachines([], [withGaps(view("cockpit", 600_000), [G])]);
		const out = mergeMachines(live, [withGaps(view("cockpit", 0), [])]);
		expect(out[0]?.heartbeat_at).toBe(iso(600_000));
		expect(out[0]?.recent_gaps).toEqual([G]);
	});

	test("an older hub's payload (no field) never erases known gaps, at the same or a newer heartbeat", () => {
		const known = mergeMachines([], [withGaps(view("cockpit", 600_000), [G])]);
		const same = mergeMachines(known, [view("cockpit", 600_000)]);
		expect(same[0]?.recent_gaps).toEqual([G]);
		const newer = mergeMachines(known, [view("cockpit", 630_000)]);
		expect(newer[0]?.heartbeat_at).toBe(iso(630_000));
		expect(newer[0]?.recent_gaps).toEqual([G]);
	});

	test("no field anywhere stays unknown (undefined), not an empty history", () => {
		const out = mergeMachines([], [view("cockpit", 0)]);
		expect(out[0]?.recent_gaps).toBeUndefined();
		const filled = mergeMachines(out, [withGaps(view("cockpit", 0), [G])]);
		expect(filled[0]?.recent_gaps).toEqual([G]);
	});

	test("a present list is the hub's answer: [] at the same heartbeat replaces what was there", () => {
		const known = mergeMachines([], [withGaps(view("cockpit", 600_000), [G])]);
		const out = mergeMachines(known, [withGaps(view("cockpit", 600_000), [])]);
		expect(out[0]?.recent_gaps).toEqual([]);
	});

	test("a malformed list is cleaned: bad rows dropped, no duplicates, ordered, newest 20", () => {
		const rows = Array.from({ length: 25 }, (_, i) =>
			gap(i * 200_000, i * 200_000 + 100_000),
		);
		const messy = [
			...rows.slice().reverse(),
			rows[24],
			{ from_at: "yesterday", until_at: iso(1), boot_changed: false },
			{ from_at: iso(5), until_at: iso(1), boot_changed: false },
			{ from_at: iso(1), until_at: iso(2), boot_changed: "yes" },
			null,
		] as unknown as MachineView["recent_gaps"];
		const out = mergeMachines([], [withGaps(view("cockpit", 0), messy)]);
		expect(out[0]?.recent_gaps).toEqual(rows.slice(-20));
		const notList = mergeMachines(
			[],
			[{ ...view("cockpit", 0), recent_gaps: "x" } as unknown as MachineView],
		);
		expect(notList[0]?.recent_gaps).toBeUndefined();
	});

	test("reconnect: the same snapshot merged twice changes nothing", () => {
		const snap = [
			withGaps(view("cockpit", 600_000), [G]),
			withGaps(view("forge", null, "unobserved"), []),
		];
		const once = mergeMachines([], snap);
		expect(mergeMachines(once, snap)).toEqual(once);
	});
});

describe("machinesAt — recent_gaps window on the screen's clock", () => {
	test("a gap that ended exactly 24 h ago is kept; 1 ms older is dropped", () => {
		const m = [
			withGaps(view("cockpit", 0), [gap(-200_000, -100_000), gap(0, 100_000)]),
		];
		const at = (ms: number) => machinesAt(m, T0 + ms)[0]?.recent_gaps;
		expect(at(DAY - 100_000)?.map((g) => g.until_at)).toEqual([
			iso(-100_000),
			iso(100_000),
		]);
		expect(at(DAY - 100_000 + 1)?.map((g) => g.until_at)).toEqual([
			iso(100_000),
		]);
		expect(
			machinesAt([view("cockpit", 0)], T0)[0]?.recent_gaps,
		).toBeUndefined();
	});
});
