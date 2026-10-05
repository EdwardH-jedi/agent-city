// 12. The support lane core invokes no provider, network, process or Git: network and process
// entry points are trapped for this whole file while the full lifecycle runs, and the module's
// source is checked for forbidden imports and calls.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runSupportJob } from "./executor.ts";
import { createFakeSupportExecutor } from "./fake-executor.ts";
import { SUPPORT_JOB_KINDS } from "./job.ts";
import { selectSupportJobs } from "./scheduler.ts";
import { requestSupportCancel, startSupportJob } from "./state.ts";
import { DEFAULT_REFS, queued } from "./testkit.ts";

const trapped: string[] = [];
const bun = Bun as unknown as Record<string, unknown>;
const originals = {
	fetch: globalThis.fetch,
	spawn: bun.spawn,
	spawnSync: bun.spawnSync,
};

beforeAll(() => {
	const trap = (name: string) => () => {
		trapped.push(name);
		throw new Error(`support lane must not call ${name}`);
	};
	globalThis.fetch = trap("fetch") as unknown as typeof fetch;
	bun.spawn = trap("Bun.spawn");
	bun.spawnSync = trap("Bun.spawnSync");
});

afterAll(() => {
	globalThis.fetch = originals.fetch;
	bun.spawn = originals.spawn;
	bun.spawnSync = originals.spawnSync;
});

describe("12. no provider / network / git process", () => {
	test("traps are installed", () => {
		expect(() => fetch("http://127.0.0.1:1")).toThrow();
		expect(trapped).toEqual(["fetch"]);
		trapped.length = 0;
	});

	test("full lifecycle for every kind touches no network or process", async () => {
		const jobs = SUPPORT_JOB_KINDS.map((kind, i) =>
			queued({ id: `iso-${i}`, kind, seq: i, inputs: DEFAULT_REFS[kind] }),
		);
		const fake = createFakeSupportExecutor();
		let pending = [...jobs];
		let completed = 0;
		// Bounded drive loop: each round launches ≤ 4 and settles them all.
		for (let round = 0; round < 10 && pending.length > 0; round++) {
			const { launch } = selectSupportJobs(pending);
			for (const job of launch) {
				const started = startSupportJob(job);
				if (!started.ok) throw new Error(started.error);
				const r = await runSupportJob(started.job, fake);
				if (r.ok && r.job.status === "COMPLETED") completed += 1;
			}
			const launched = new Set(launch.map((j) => j.id));
			pending = pending.filter((j) => !launched.has(j.id));
		}
		expect(completed).toBe(SUPPORT_JOB_KINDS.length);
		expect(fake.calls.length).toBe(SUPPORT_JOB_KINDS.length);

		const c = requestSupportCancel(queued({ id: "iso-cancel" }));
		expect(c.ok && c.job.status).toBe("CANCELLED");
		expect(trapped).toEqual([]);
	});
});

describe("12. static: the module imports and calls nothing with side effects", () => {
	const dir = import.meta.dir;
	const sources = readdirSync(dir)
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
		.map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") }));

	test("sources found", () => {
		expect(sources.map((s) => s.file).sort()).toEqual(
			[
				"artifact.ts",
				"executor.ts",
				"fake-executor.ts",
				"guards.ts",
				"index.ts",
				"job.ts",
				"scheduler.ts",
				"state.ts",
				"testkit.ts",
				"vocabulary.ts",
			].sort(),
		);
	});

	test.each([
		"child_process",
		"Bun.spawn",
		"Bun.$",
		"fetch(",
		"node:fs",
		"node:net",
		"node:http",
		"node:https",
		"node:dgram",
		"node:worker_threads",
		"bun:sqlite",
		"WebSocket",
		"XMLHttpRequest",
		"setTimeout",
		"setInterval",
		"process.env",
		"console.",
		"import(",
		"require(",
		"../managed",
		"workspace-m1",
	])("no source contains %p", (needle) => {
		for (const { file, text } of sources)
			expect([file, text.includes(needle)]).toEqual([file, false]);
	});

	test("only zod, @agent-city/schema and sibling modules are imported", () => {
		const allowed = (spec: string) =>
			spec === "zod" ||
			spec === "@agent-city/schema" ||
			/^\.\/[a-z-]+\.ts$/.test(spec);
		for (const { file, text } of sources)
			for (const m of text.matchAll(/\bfrom\s+"([^"]+)"/g))
				expect([file, m[1], allowed(m[1] ?? "")]).toEqual([file, m[1], true]);
	});
});
