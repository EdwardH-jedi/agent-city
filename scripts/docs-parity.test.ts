// F18: README → Environment table and .env.example list exactly the same variables, and every
// variable the code reads is in both. Also CLAUDE.md ≡ AGENTS.md. Reads docs/source only (never .env).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function readmeEnvKeys(): Set<string> {
	const md = read("README.md");
	const start = md.indexOf("## Environment");
	const end = md.indexOf("\n## ", start + 1);
	const keys = new Set<string>();
	for (const line of md.slice(start, end).split("\n")) {
		if (!line.startsWith("|")) continue;
		const first = line.split("|")[1] ?? "";
		for (const m of first.matchAll(/`([A-Z][A-Z0-9_]+)`/g))
			if (m[1]) keys.add(m[1]);
	}
	return keys;
}

function exampleKeys(): Set<string> {
	return new Set(
		read(".env.example")
			.split("\n")
			.map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1])
			.filter((k): k is string => !!k),
	);
}

/** Env names referenced by non-test source + the hook launcher. */
function codeKeys(): Set<string> {
	const files: string[] = ["apps/collector/bin/claude-hook"];
	const walk = (dir: string) => {
		for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory() && e.name !== "node_modules") walk(p);
			// test code is not configuration: `*.test.ts` and the e2e browser suites (`*.suite.ts`)
			// may read runner-only variables (e.g. a case filter) that the app never reads
			else if (
				/\.tsx?$/.test(e.name) &&
				!e.name.endsWith(".test.ts") &&
				!e.name.endsWith(".suite.ts")
			)
				files.push(p);
		}
	};
	walk("apps");
	walk("packages");
	const keys = new Set<string>();
	for (const f of files) {
		const src = read(f);
		for (const m of src.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]+)/g))
			if (m[1]) keys.add(m[1]);
		for (const m of src.matchAll(/\$\{([A-Z][A-Z0-9_]+):-/g))
			if (m[1]) keys.add(m[1]);
	}
	// collector config reads its keys through a whitelist array
	const cfg = read("apps/collector/src/config.ts");
	const list = /const KEYS = \[([\s\S]*?)\] as const/.exec(cfg)?.[1] ?? "";
	for (const m of list.matchAll(/"([A-Z][A-Z0-9_]+)"/g))
		if (m[1]) keys.add(m[1]);
	return keys;
}

const sorted = (s: Set<string>) => [...s].sort();

describe("docs parity (F18)", () => {
	test("README env table ≡ .env.example", () => {
		expect(sorted(readmeEnvKeys())).toEqual(sorted(exampleKeys()));
	});

	test("every env var the code reads is documented in both", () => {
		const documented = readmeEnvKeys();
		const code = codeKeys();
		expect(code.size).toBeGreaterThan(15); // the scan itself works
		expect(sorted(code).filter((k) => !documented.has(k))).toEqual([]);
	});

	test("the audit's missing keys are now present", () => {
		const keys = exampleKeys();
		for (const k of [
			"SPOOL_MAX_MB",
			"SPOOL_MAX_AGE_DAYS",
			"AGENTCITY_HOOK_KILL_S",
			"AGENTCITY_HOME",
			"AGENTCITY_DEBUG",
			"CODEX_BACKFILL_HOURS",
			"CODEX_SESSIONS_DIR",
		])
			expect(keys.has(k)).toBe(true);
	});

	test(".env.example carries no secret values", () => {
		const env = read(".env.example");
		for (const k of ["GITHUB_TOKEN", "INGEST_TOKEN", "MANAGED_TOKEN"])
			expect(env).toMatch(new RegExp(`^${k}=$`, "m"));
	});

	test("CLAUDE.md and AGENTS.md are byte-identical", () => {
		expect(read("AGENTS.md")).toBe(read("CLAUDE.md"));
	});
});
