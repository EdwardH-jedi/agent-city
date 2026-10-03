// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests inspect raw, untyped HTTP bodies and SQLite rows on purpose
// ADV-REDACT — omitted-hunk YAML secret gap and sanitized failure paths, through the real engine
// evidence step (complete-context disclosure) on disposable fixture commits. For every case the
// runtime canaries must be absent from every surface: all DB tables, every file under the artifacts
// root, the diff the reviewer received, task view / snapshot / artifact routes, captured hub logs.
// Outcome per case may be "disclosed (masked)" or "withheld (evidence_invalid)" — both fail closed.
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { redactDiff } from "../../src/managed/evidence.ts";
import { GIT } from "../../src/managed/testkit.ts";
import {
	approveGate1,
	artifactRows,
	assertIsolation,
	type Client,
	type ComposedHub,
	commitToFixture,
	composedHub,
	liveServers,
	teardown,
	waitStage,
	writingImplementer,
} from "./harness.ts";

assertIsolation();
afterEach(teardown);

// ── log capture (the hub runs in this process) ──────────────────────────────
const logs: string[] = [];
const orig = { log: console.log, warn: console.warn, error: console.error };
beforeAll(() => {
	for (const k of ["log", "warn", "error"] as const)
		console[k] = (...a: unknown[]) => {
			logs.push(a.map(String).join(" "));
		};
});
afterAll(() => {
	Object.assign(console, orig);
	expect(liveServers).toBe(0);
});

const hex = (n: number) =>
	Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("hex");
/** Non-token-shaped secret body line: only its YAML context makes it secret. */
const secretLine = () => `SECRETBODY${hex(10)}q${hex(5)}`;
const lines = (n: number) => Array.from({ length: n }, secretLine);

function walk(dir: string, out: string[] = []): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}
	for (const n of names) {
		const p = join(dir, n);
		const st = lstatSync(p);
		if (st.isDirectory()) walk(p, out);
		else if (st.isFile()) out.push(p);
	}
	return out;
}

/** Every surface that holds a canary, by name (expected: none). */
async function leaks(
	H: ComposedHub,
	c: Client,
	taskId: string,
	managedTaskId: string,
	canaries: string[],
) {
	const which = (s: string) =>
		canaries.map((x, i) => (s.includes(x) ? i : -1)).filter((i) => i >= 0);
	const has = (s: string) => which(s).length > 0;
	const found: string[] = [];
	const tables = (
		H.db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {
			name: string;
		}[]
	).map((t) => t.name);
	for (const t of tables)
		if (has(JSON.stringify(H.db.query(`SELECT * FROM "${t}"`).all())))
			found.push(`db:${t}`);
	for (const f of walk(H.fx.config.artifacts_root)) {
		const t = readFileSync(f, "utf8");
		if (has(t))
			found.push(
				`file:${f.slice(H.fx.config.artifacts_root.length).replace(/^.*\//, "")}#${which(t).join(",")}`,
			);
	}
	for (const i of H.calls.reviewInputs)
		if (has(i.diff)) found.push("reviewer_input");
	if (has((await c.get(`/tasks/${taskId}`)).text)) found.push("http:task");
	if (has((await c.get("/snapshot")).text)) found.push("http:snapshot");
	for (const a of artifactRows(H.db, managedTaskId)) {
		const r = await c.get(`/tasks/${taskId}/artifacts/${a.id}`);
		if (has(r.text)) found.push(`http:artifact:${a.name}`);
	}
	if (logs.some(has)) found.push("logs");
	for (const a of H.alarms) if (has(a.detail)) found.push("alarm");
	return found;
}

interface Case {
	base: Record<string, string>;
	change: Record<string, string | null>;
	canaries: string[];
	limits?: Record<string, unknown>;
	scope?: string[];
}

async function runCase(cs: Case) {
	const H = composedHub({
		...(cs.limits ? { fixture: { limits: cs.limits } } : {}),
		adapters: (b) => writingImplementer(b, () => cs.change),
	});
	await commitToFixture(H.fx, cs.base);
	const c = await H.signIn();
	const a = await approveGate1(
		c,
		H.fx,
		cs.scope ? { scope: { allowed: cs.scope, protected: [] } } : {},
	);
	const v = await waitStage(c, a.taskId, [
		"awaiting_acceptance",
		"execution_ended",
	]);
	const t = H.db
		.query("SELECT failure_kind FROM managed_tasks WHERE id = ?")
		.get(a.managedTaskId) as any;
	const outcome =
		v.task.stage === "awaiting_acceptance"
			? "disclosed"
			: `ended:${t.failure_kind}`;
	return {
		H,
		c,
		a,
		outcome,
		found: await leaks(H, c, a.taskId, a.managedTaskId, cs.canaries),
	};
}

const block = (header: string, body: string[], indent = "    ") =>
	[header, ...body.map((l) => `${indent}${l}`)].join("\n");

const outcomes: Record<string, string> = {};

describe("ADV-REDACT omitted-hunk YAML and sanitized failure paths", () => {
	test("ADV-REDACT-01 secret header >3 lines above an edited block-body line (header outside the hunk) + positive control on baseline redactDiff", async () => {
		const body = lines(9);
		const edited = secretLine();
		const yaml = (b: string[]) =>
			`service:\n  name: demo\n${block("  password: |", b)}\n  port: 8080\n`;
		const changedBody = body.map((l, i) => (i === 6 ? edited : l));
		const { H, a, outcome, found } = await runCase({
			base: { "config.yaml": yaml(body) },
			change: { "config.yaml": yaml(changedBody) },
			canaries: [...body, edited],
		});
		outcomes["01"] = outcome;
		expect(found).toEqual([]);
		// positive control (R-A7): the same raw diff through the pre-M1 redactDiff leaks body lines
		const run = H.db
			.query("SELECT candidate_sha FROM managed_runs WHERE task_id = ?")
			.get(a.managedTaskId) as any;
		const baseSha = (
			H.db
				.query("SELECT base_sha FROM managed_tasks WHERE id = ?")
				.get(a.managedTaskId) as any
		).base_sha;
		const raw = spawnSync(GIT, ["diff", baseSha, run.candidate_sha], {
			cwd: H.fx.repoPath,
			encoding: "utf8",
		}).stdout;
		expect(raw).toContain(edited);
		const legacy = redactDiff(raw);
		expect([edited, ...body].some((x) => legacy.includes(x))).toBe(true);
	});

	test("ADV-REDACT-02 unchanged secret block body shown only as context beside a changed non-secret line", async () => {
		const body = lines(7);
		const yaml = (port: string) =>
			`${block("password: |", body, "  ")}\nport: ${port}\n`;
		const r = await runCase({
			base: { "app.yaml": yaml("1") },
			change: { "app.yaml": yaml("2") },
			canaries: body,
		});
		outcomes["02"] = r.outcome;
		expect(r.found).toEqual([]);
	});

	test("ADV-REDACT-03 secret header only in the old version / only in the new version", async () => {
		for (const [from, to] of [
			["password", "description"],
			["description", "password"],
		]) {
			const body = lines(9);
			const edited = secretLine();
			const yaml = (k: string, b: string[]) =>
				`${block(`${k}: |`, b, "  ")}\nend: true\n`;
			const r = await runCase({
				base: { "rename.yaml": yaml(from as string, body) },
				change: {
					"rename.yaml": yaml(
						to as string,
						body.map((l, i) => (i === 7 ? edited : l)),
					),
				},
				// a line counts as secret in the version(s) where it sits under a secret key:
				// password→description: every old body line (incl. the removed one);
				// description→password: every new body line (unchanged ones + the edited one)
				canaries:
					to === "password"
						? [...body.filter((_, i) => i !== 7), edited]
						: body,
			});
			outcomes[`03:${from}->${to}`] = r.outcome;
			expect([from, to, r.found]).toEqual([from, to, []]);
			await r.H.stop();
		}
	});

	const variants: [string, (b: string[]) => string][] = [
		["|-", (b) => `${block("token: |-", b, "  ")}\nz: 1\n`],
		["|+", (b) => `${block("token: |+", b, "  ")}\nz: 1\n`],
		[">", (b) => `${block("secret: >", b, "  ")}\nz: 1\n`],
		[">-", (b) => `${block("secret: >-", b, "  ")}\nz: 1\n`],
		["|2", (b) => `${block("api_key: |2", b, "    ")}\nz: 1\n`],
		[
			"list item",
			(b) =>
				`items:\n  - name: a\n${block("    password: |", b, "      ")}\n  - name: b\n`,
		],
		["anchor", (b) => `${block("password: &pw |", b, "  ")}\ncopy: *pw\n`],
		[
			"quoted multi-line",
			(b) =>
				`password: "${b[0]}\n${b
					.slice(1)
					.map((l) => `  ${l}`)
					.join("\n")}"\nz: 1\n`,
		],
		[
			"backslash continuation",
			(b) =>
				`password: "${b.map((l, i) => (i === 0 ? `${l}\\` : `  ${l}\\`)).join("\n")}"\nz: 1\n`,
		],
		[
			"flow mapping",
			(b) =>
				`creds: {password: "${b[0]}\n${b
					.slice(1)
					.map((l) => `  ${l}`)
					.join("\n")}"}\nz: 1\n`,
		],
	];
	for (const [name, mk] of variants)
		test(`ADV-REDACT-04/05 block variant ${name}`, async () => {
			const body = lines(9);
			const edited = secretLine();
			const r = await runCase({
				base: { "variant.yaml": mk(body) },
				change: {
					"variant.yaml": mk(body.map((l, i) => (i === 6 ? edited : l))),
				},
				canaries: [...body, edited],
			});
			outcomes[`04:${name}`] = r.outcome;
			expect(r.found).toEqual([]);
		});

	test("ADV-REDACT-06 header in hunk 1, body edit in hunk 2 of the same file", async () => {
		const body = lines(14);
		const edited = secretLine();
		const yaml = (top: string, b: string[]) =>
			`top: ${top}\nfiller: x\n${block("password: |", b, "  ")}\nend: 1\n`;
		const r = await runCase({
			base: { "two.yaml": yaml("a", body) },
			change: {
				"two.yaml": yaml(
					"b",
					body.map((l, i) => (i === 12 ? edited : l)),
				),
			},
			canaries: [...body, edited],
		});
		outcomes["06"] = r.outcome;
		expect(r.found).toEqual([]);
	});

	test("ADV-REDACT-07 rename / delete / add / binary / CRLF / no trailing newline / non-UTF-8", async () => {
		const cases: [string, () => Case][] = [
			[
				"rename+edit",
				() => {
					const body = lines(9);
					const e = secretLine();
					const y = (b: string[]) => `${block("password: |", b, "  ")}\nz: 1\n`;
					return {
						base: { "old/name.yaml": y(body) },
						change: {
							"old/name.yaml": null,
							"new/name.yaml": y(body.map((l, i) => (i === 7 ? e : l))),
						},
						canaries: [...body, e],
					};
				},
			],
			[
				"delete",
				() => {
					const body = lines(6);
					return {
						base: { "gone.yaml": `${block("password: |", body, "  ")}\n` },
						change: { "gone.yaml": null },
						canaries: body,
					};
				},
			],
			[
				"add",
				() => {
					const body = lines(6);
					return {
						base: { "keep.txt": "keep\n" },
						change: { "added.yaml": `${block("password: |", body, "  ")}\n` },
						canaries: body,
					};
				},
			],
			[
				"binary",
				() => {
					const s = secretLine();
					return {
						base: { "keep.txt": "keep\n" },
						change: { "blob.bin": `\u0000\u0001password: ${s}\u0000` },
						canaries: [s],
					};
				},
			],
			[
				"crlf",
				() => {
					const body = lines(9);
					const e = secretLine();
					const y = (b: string[]) =>
						`${block("password: |", b, "  ")}\nz: 1\n`.replace(/\n/g, "\r\n");
					return {
						base: { "crlf.yaml": y(body) },
						change: { "crlf.yaml": y(body.map((l, i) => (i === 7 ? e : l))) },
						canaries: [...body, e],
					};
				},
			],
			[
				"no trailing newline",
				() => {
					const body = lines(9);
					const e = secretLine();
					const y = (b: string[]) => block("password: |", b, "  ");
					return {
						base: { "nonl.yaml": y(body) },
						change: { "nonl.yaml": y(body.map((l, i) => (i === 8 ? e : l))) },
						canaries: [...body, e],
					};
				},
			],
			[
				"latin-1 byte",
				() => {
					const body = lines(9);
					const e = secretLine();
					const y = (b: string[]) =>
						`name: café\n${block("password: |", b, "  ")}\nz: 1\n`;
					return {
						base: { "latin.yaml": y(body) },
						change: { "latin.yaml": y(body.map((l, i) => (i === 7 ? e : l))) },
						canaries: [...body, e],
					};
				},
			],
		];
		const results: Record<string, string[]> = {};
		for (const [name, mk] of cases) {
			const r = await runCase(mk());
			outcomes[`07:${name}`] = r.outcome;
			results[name] = r.found;
			await r.H.stop();
		}
		expect(results).toEqual(Object.fromEntries(cases.map(([n]) => [n, []])));
	}, 60_000);

	test("ADV-REDACT-08 required context larger than the bound → withheld, SAFE-FAIL", async () => {
		const body = lines(9);
		const edited = secretLine();
		const pad = Array.from(
			{ length: 120 },
			(_, i) => `filler_${i}: value-${i}`,
		).join("\n");
		const y = (b: string[]) =>
			`${pad}\n${block("password: |", b, "  ")}\nz: 1\n`;
		const r = await runCase({
			base: { "huge.yaml": y(body) },
			change: { "huge.yaml": y(body.map((l, i) => (i === 6 ? edited : l))) },
			canaries: [...body, edited],
			limits: { max_context_file_bytes: 1024 },
		});
		outcomes["08"] = r.outcome;
		expect(r.found).toEqual([]);
		expect(r.outcome).toBe("ended:evidence_invalid");
		expect(r.H.calls.review).toBe(0);
	});

	test("ADV-REDACT-09 unparsable YAML around a secret-looking block → no canary anywhere", async () => {
		const body = lines(9);
		const edited = secretLine();
		const y = (b: string[]) =>
			`key: [unclosed\n\tbad: indentation\n${block("password: |", b, "  ")}\n: : :\n`;
		const r = await runCase({
			base: { "broken.yaml": y(body) },
			change: { "broken.yaml": y(body.map((l, i) => (i === 6 ? edited : l))) },
			canaries: [...body, edited],
		});
		outcomes["09"] = r.outcome;
		expect(r.found).toEqual([]);
	});

	test("ADV-REDACT-10 base blob of the context file missing from the object store → fail closed, no canary", async () => {
		const body = lines(9);
		const edited = secretLine();
		const y = (b: string[]) => `${block("password: |", b, "  ")}\nz: 1\n`;
		const H = composedHub({
			adapters: (b) =>
				writingImplementer(b, () => ({
					"miss.yaml": y(body.map((l, i) => (i === 6 ? edited : l))),
				})),
		});
		await commitToFixture(H.fx, { "miss.yaml": y(body) });
		const blob = spawnSync(GIT, ["rev-parse", "HEAD:miss.yaml"], {
			cwd: H.fx.repoPath,
			encoding: "utf8",
		}).stdout.trim();
		const c = await H.signIn();
		const a = await approveGate1(c, H.fx);
		rmSync(
			join(H.fx.repoPath, ".git", "objects", blob.slice(0, 2), blob.slice(2)),
			{ force: true },
		);
		const v = await waitStage(c, a.taskId, [
			"awaiting_acceptance",
			"execution_ended",
		]);
		outcomes["10"] = v.task.stage;
		expect(v.task.stage).toBe("execution_ended");
		expect(
			await leaks(H, c, a.taskId, a.managedTaskId, [...body, edited]),
		).toEqual([]);
	});

	test("ADV-REDACT-11 a FIFO written by the implementer next to the secret edit: no hang, no canary", async () => {
		const body = lines(9);
		const edited = secretLine();
		const y = (b: string[]) => `${block("password: |", b, "  ")}\nz: 1\n`;
		const H = composedHub({
			adapters: (base) => {
				const w = writingImplementer(base, () => ({
					"fifo.yaml": y(body.map((l, i) => (i === 6 ? edited : l))),
				}));
				return {
					reviewer: (m) => w.reviewer(m),
					implementer(m) {
						const a = w.implementer(m);
						if (!a) return null;
						return {
							...a,
							async implement(input, ctx) {
								spawnSync("/usr/bin/mkfifo", [
									join(input.worktree, "pipe.yaml"),
								]);
								return a.implement(input, ctx);
							},
						};
					},
				};
			},
		});
		await commitToFixture(H.fx, { "fifo.yaml": y(body) });
		const c = await H.signIn();
		const t0 = Date.now();
		const a = await approveGate1(c, H.fx);
		const v = await waitStage(c, a.taskId, [
			"awaiting_acceptance",
			"execution_ended",
		]);
		outcomes["11"] = v.task.stage;
		expect(Date.now() - t0).toBeLessThan(20_000);
		expect(
			await leaks(H, c, a.taskId, a.managedTaskId, [...body, edited]),
		).toEqual([]);
	});

	test("ADV-REDACT-12 secret-named keys in .env-style and JSON files inside omitted context", async () => {
		const results: Record<string, string[]> = {};
		const envBody = lines(8);
		const envEdited = secretLine();
		const env = (b: string[]) =>
			`APP=demo\nPRIVATE_KEY="${b.join("\n")}"\nOTHER=1\n`;
		const r1 = await runCase({
			base: { "config/app.env": env(envBody) },
			change: {
				"config/app.env": env(envBody.map((l, i) => (i === 6 ? envEdited : l))),
			},
			canaries: [...envBody, envEdited],
		});
		outcomes["12:env"] = r1.outcome;
		results.env = r1.found;
		await r1.H.stop();
		const jBody = lines(8);
		const jEdited = secretLine();
		const json = (b: string[]) =>
			`{\n  "name": "demo",\n  "credentials": {\n${b.map((l, i) => `    "k${i}": "${l}"`).join(",\n")}\n  },\n  "z": 1\n}\n`;
		const r2 = await runCase({
			base: { "settings.json": json(jBody) },
			change: {
				"settings.json": json(jBody.map((l, i) => (i === 6 ? jEdited : l))),
			},
			canaries: [...jBody, jEdited],
		});
		outcomes["12:json"] = r2.outcome;
		results.json = r2.found;
		expect(results).toEqual({ env: [], json: [] });
	});

	test("ADV-REDACT-13 no canary in any captured hub log line across all cases (sanitized failure paths)", () => {
		// leaks() already checks logs per case; this records the per-case outcomes for the report
		logs.push(""); // keep capture alive
		orig.log(`[adv-redact outcomes] ${JSON.stringify(outcomes)}`);
		expect(Object.keys(outcomes).length).toBeGreaterThan(10);
	});
});
