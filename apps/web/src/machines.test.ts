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
