import { describe, expect, test } from "bun:test";
import { Heartbeat } from "@agent-city/schema";
import type { CollectorConfig } from "./config.ts";
import {
	createSender,
	heartbeatConfigError,
	runHeartbeatLoop,
} from "./heartbeat.ts";

// No shell, no path separators, no spawned process: only injected fetch and sleep.
const cfg = (over: Partial<CollectorConfig> = {}): CollectorConfig => ({
	hubUrl: "http://127.0.0.1:4317",
	ingestToken: "test-ingest-token",
	machine: "cockpit",
	home: "unused",
	hostname: "test-host",
	debug: false,
	spoolLimits: { maxBytes: 1, maxAgeMs: 1 },
	codex: { sessionsDir: "unused", backfillMs: 0, eventFilter: false },
	...over,
});

const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");

describe("heartbeatConfigError", () => {
	test("ok config", () => {
		expect(heartbeatConfigError(cfg())).toBeNull();
	});
	test("missing token and unknown machine are refused, without echoing the token", () => {
		expect(heartbeatConfigError(cfg({ ingestToken: null }))).toContain(
			"INGEST_TOKEN",
		);
		const msg = heartbeatConfigError(cfg({ machine: "laptop" }));
		expect(msg).toContain("AGENTCITY_MACHINE");
		expect(msg).not.toContain("test-ingest-token");
	});
});

describe("createSender", () => {
	test("every body satisfies the hub's strict schema; seq rises; boot_id is stable", () => {
		const s = createSender(cfg(), { now: fixedNow });
		const a = Heartbeat.parse(s.build());
		const b = Heartbeat.parse(s.build());
		expect(a.machine_id).toBe("cockpit");
		expect(a.interval_s).toBe(30);
		expect([a.seq, b.seq]).toEqual([0, 1]);
		expect(a.boot_id).toBe(b.boot_id);
		expect(a.sent_at).toBe("2026-01-01T00:00:00.000Z");
	});

	test("two senders (two process starts) get different boot_ids", () => {
		const x = createSender(cfg()).build();
		const y = createSender(cfg()).build();
		expect(x.boot_id).not.toBe(y.boot_id);
	});

	test("hostname is cut to 64 chars and omitted when empty", () => {
		expect(
			createSender(cfg({ hostname: "h".repeat(100) })).build().hostname,
		).toHaveLength(64);
		expect(
			createSender(cfg({ hostname: "" })).build().hostname,
		).toBeUndefined();
	});

	test("send POSTs JSON with the bearer token to /ingest/heartbeat", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		const fetchImpl = (async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return new Response('{"accepted":true}', { status: 200 });
		}) as unknown as typeof fetch;
		const s = createSender(cfg({ hubUrl: "http://hub.test:4317" }), {
			fetchImpl,
			now: fixedNow,
		});
		expect(await s.send()).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.url).toBe("http://hub.test:4317/ingest/heartbeat");
		expect(seen[0]?.init.method).toBe("POST");
		const headers = seen[0]?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer test-ingest-token");
		const body = JSON.parse(String(seen[0]?.init.body));
		expect(Heartbeat.safeParse(body).success).toBe(true);
	});

	test("a hub that is down does not kill the sender: false, no throw, seq keeps moving", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			throw new Error("connect ECONNREFUSED");
		}) as unknown as typeof fetch;
		const s = createSender(cfg(), { fetchImpl });
		expect(await s.send()).toBe(false);
		expect(await s.send()).toBe(false);
		expect(calls).toBe(2);
		expect(s.build().seq).toBe(2); // failed beats are dropped, never replayed
	});

	test("401, 503, 413 and 400 are reported as not delivered", async () => {
		for (const status of [401, 503, 413, 400]) {
			const fetchImpl = (async () =>
				new Response("{}", { status })) as unknown as typeof fetch;
			expect(await createSender(cfg(), { fetchImpl }).send()).toBe(false);
		}
	});
});

describe("runHeartbeatLoop", () => {
	test("keeps beating through failures and stops when aborted", async () => {
		const stop = new AbortController();
		const results = [false, false, true, true];
		let i = 0;
		const seen: boolean[] = [];
		const slept: number[] = [];
		await runHeartbeatLoop({
			send: async () => results[i++] ?? true,
			intervalMs: 30_000,
			signal: stop.signal,
			sleep: async (ms) => {
				slept.push(ms);
				if (slept.length === 3) stop.abort();
			},
			onResult: (ok) => seen.push(ok),
		});
		expect(seen).toEqual([false, false, true]);
		expect(slept).toEqual([30_000, 30_000, 30_000]);
	});

	test("an already-aborted signal sends nothing", async () => {
		const stop = new AbortController();
		stop.abort();
		let sent = 0;
		await runHeartbeatLoop({
			send: async () => {
				sent++;
				return true;
			},
			intervalMs: 1,
			signal: stop.signal,
		});
		expect(sent).toBe(0);
	});
});
