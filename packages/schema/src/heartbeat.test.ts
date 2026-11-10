import { describe, expect, test } from "bun:test";
import {
	HEARTBEAT_MAX_BODY_BYTES,
	HEARTBEAT_OFFLINE_FROM_MS,
	HEARTBEAT_ONLINE_BELOW_MS,
	Heartbeat,
	machineStatus,
} from "./index.ts";

const valid = {
	schema: 1,
	machine_id: "spine",
	hostname: "rx",
	boot_id: "boot-1234-abcd",
	seq: 0,
	sent_at: "2026-01-01T00:00:00.000Z",
	interval_s: 30,
};

describe("Heartbeat", () => {
	test("accepts the documented shape, with or without hostname", () => {
		expect(Heartbeat.safeParse(valid).success).toBe(true);
		const { hostname: _h, ...noHost } = valid;
		expect(Heartbeat.safeParse(noHost).success).toBe(true);
	});

	test("rejects a machine outside cockpit / forge / spine", () => {
		for (const machine_id of ["laptop", "RTX", "", "cockpit "]) {
			expect(Heartbeat.safeParse({ ...valid, machine_id }).success).toBe(false);
		}
	});

	test("is strict: any extra key is refused, so no path, command or prompt can ride along", () => {
		for (const extra of ["cwd", "command", "prompt", "token", "note"]) {
			expect(Heartbeat.safeParse({ ...valid, [extra]: "x" }).success).toBe(
				false,
			);
		}
	});

	test("boot_id, seq, interval_s and hostname bounds", () => {
		const bad = (over: Record<string, unknown>) =>
			Heartbeat.safeParse({ ...valid, ...over }).success;
		expect(bad({ boot_id: "short" })).toBe(false); // < 8
		expect(bad({ boot_id: "x".repeat(65) })).toBe(false); // > 64
		expect(bad({ boot_id: "has space here" })).toBe(false);
		expect(bad({ boot_id: "a/b/c/d/e/f/g" })).toBe(false);
		expect(bad({ seq: -1 })).toBe(false);
		expect(bad({ seq: 1.5 })).toBe(false);
		expect(bad({ interval_s: 4 })).toBe(false);
		expect(bad({ interval_s: 301 })).toBe(false);
		expect(bad({ interval_s: 5 })).toBe(true);
		expect(bad({ interval_s: 300 })).toBe(true);
		expect(bad({ hostname: "h".repeat(65) })).toBe(false);
		expect(bad({ hostname: "h".repeat(64) })).toBe(true);
		expect(bad({ hostname: "" })).toBe(false);
		expect(bad({ sent_at: "yesterday" })).toBe(false);
		expect(bad({ schema: 2 })).toBe(false);
	});

	test("a normal beat is far below the 4 KiB body limit", () => {
		expect(JSON.stringify(valid).length).toBeLessThan(
			HEARTBEAT_MAX_BODY_BYTES / 10,
		);
	});
});

describe("machineStatus", () => {
	const at = "2026-01-01T00:00:00.000Z";
	const after = (ms: number) => new Date(Date.parse(at) + ms);

	test("unobserved without a receive time", () => {
		expect(machineStatus(null, after(0))).toBe("unobserved");
		expect(machineStatus("not a date", after(0))).toBe("unobserved");
	});

	test("boundaries: 89 s online, 90 s stale, 599 s stale, 600 s offline", () => {
		expect(machineStatus(at, after(0))).toBe("online");
		expect(machineStatus(at, after(89_000))).toBe("online");
		expect(machineStatus(at, after(90_000))).toBe("stale");
		expect(machineStatus(at, after(599_000))).toBe("stale");
		expect(machineStatus(at, after(600_000))).toBe("offline");
		expect(machineStatus(at, after(24 * 3_600_000))).toBe("offline");
	});

	test("thresholds are the documented constants", () => {
		expect(HEARTBEAT_ONLINE_BELOW_MS).toBe(90_000);
		expect(HEARTBEAT_OFFLINE_FROM_MS).toBe(600_000);
	});

	test("a receive time a little ahead of now counts as just received", () => {
		expect(machineStatus(at, after(-5_000))).toBe("online");
	});
});
