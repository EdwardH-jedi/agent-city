import { describe, expect, test } from "bun:test";
import { Heartbeat } from "@agent-city/schema";
import type { CollectorConfig } from "./config.ts";
import {
	createSender,
	heartbeatConfigError,
	hubLabel,
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
	usage: { enabled: false, claudeProjectsDir: "unused" },
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

describe("hubLabel", () => {
	test("prints the origin only: no user:password, no path, no query", () => {
		const label = hubLabel(
			"http://user:pw@127.0.0.1:4317/secret/path?token=abc",
		);
		expect(label).toBe("http://127.0.0.1:4317");
	});
	test("a token-shaped host name is redacted", () => {
		const secret = `sk-ant-${"a".repeat(40)}`;
		expect(hubLabel(`https://${secret}.example`)).not.toContain(secret);
	});
	test("an invalid URL gives a fixed message, never the input", () => {
		const fake = `sk-ant-${"b".repeat(20)}`; // built at runtime: fixtures never hold key-shaped literals
		expect(hubLabel(`not a url ${fake}`)).toBe("(HUB_URL is not a valid URL)");
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

	test("a token-shaped hostname is redacted before it is sent", () => {
		const secret = `ghp_${"a".repeat(36)}`;
		const body = createSender(cfg({ hostname: secret })).build();
		expect(JSON.stringify(body)).not.toContain(secret);
	});

	test("two senders (two process starts) get different boot_ids", () => {
		const x = createSender(cfg()).build();
		const y = createSender(cfg()).build();
		expect(x.boot_id).not.toBe(y.boot_id);
	});

	test("a long hostname always still satisfies the hub schema; an empty one is omitted", () => {
		for (const hostname of [
			"h".repeat(100),
			"host ".repeat(40),
			`${"a".repeat(63)} b`,
		]) {
			const body = createSender(cfg({ hostname })).build();
			expect(Heartbeat.safeParse(body).success).toBe(true);
			expect((body.hostname ?? "").length).toBeLessThanOrEqual(64);
		}
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

	test("sends even when no onResult callback is given", async () => {
		const stop = new AbortController();
		let sent = 0;
		await runHeartbeatLoop({
			send: async () => {
				sent++;
				return true;
			},
			intervalMs: 1,
			signal: stop.signal,
			sleep: async () => {
				if (sent === 2) stop.abort();
			},
		});
		expect(sent).toBe(2);
	});

	test("the default sleep leaves no abort listener behind", async () => {
		// Count add/remove on a signal across several completed waits.
		const stop = new AbortController();
		let live = 0;
		const add = stop.signal.addEventListener.bind(stop.signal);
		const remove = stop.signal.removeEventListener.bind(stop.signal);
		stop.signal.addEventListener = ((...a: Parameters<typeof add>) => {
			live++;
			return add(...a);
		}) as typeof add;
		stop.signal.removeEventListener = ((...a: Parameters<typeof remove>) => {
			live--;
			return remove(...a);
		}) as typeof remove;
		let sent = 0;
		await runHeartbeatLoop({
			send: async () => {
				if (++sent === 4) stop.abort();
				return true;
			},
			intervalMs: 1,
			signal: stop.signal,
		});
		expect(sent).toBe(4);
		expect(live).toBeLessThanOrEqual(0);
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
