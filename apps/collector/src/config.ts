// Collector config. Hooks run with cwd = the user's project, so Bun must NOT auto-load that
// project's .env (callers use `bun --no-env-file`). We read this checkout's own .env explicitly and
// keep only the keys below — never the whole file (it also holds GITHUB_TOKEN).
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const REPO_ENV_PATH = join(import.meta.dir, "../../../.env");

const KEYS = [
	"HUB_URL",
	"INGEST_TOKEN",
	"AGENTCITY_MACHINE",
	"AGENTCITY_HOME",
	"AGENTCITY_DEBUG",
	"AGENTCITY_USAGE",
	"AGENTCITY_CLAUDE_PROJECTS_DIR",
	"SPOOL_MAX_MB",
	"SPOOL_MAX_AGE_DAYS",
	"CODEX_SESSIONS_DIR",
	"CODEX_BACKFILL_HOURS",
	"CODEX_BACKFILL_EVENT_FILTER",
] as const;
type Key = (typeof KEYS)[number];

export interface CollectorConfig {
	hubUrl: string;
	ingestToken: string | null;
	machine: string;
	/** ~/.agentcity — spool, offsets, debug log. */
	home: string;
	hostname: string;
	debug: boolean;
	spoolLimits: { maxBytes: number; maxAgeMs: number };
	codex: {
		/** CODEX_SESSIONS_DIR, default ~/.codex/sessions. */
		sessionsDir: string;
		/** CODEX_BACKFILL_HOURS (default 2): first-sight window, by file mtime. */
		backfillMs: number;
		/** CODEX_BACKFILL_EVENT_FILTER=1: also drop first-sight records older than the window (F14). */
		eventFilter: boolean;
	};
	usage: {
		/** AGENTCITY_USAGE=0 turns the token usage poller off (default on). */
		enabled: boolean;
		/** AGENTCITY_CLAUDE_PROJECTS_DIR, default ~/.claude/projects (Claude Code transcripts). */
		claudeProjectsDir: string;
	};
}

// The .env parser below is a hand-written linear scan with exactly the results of the regexes it
// replaced, /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/ and the comment strip
// /\s+#.*$/. Those re-scanned whitespace runs from every position (O(n²), one shape O(n³)), and every
// Claude Code hook parses this file at startup (Hard rule 4: bounded time). config-bounded.test.ts
// keeps the old regexes as the oracle.
const WS = /\s/;
const KEY_START = /[A-Za-z_]/;
const KEY_CHAR = /[A-Za-z0-9_]/;
/** JS `\s`, one char. */
const isWs = (c: string | undefined): boolean => c !== undefined && WS.test(c);
/** Whitespace to `\s` but a line end to `.`: a value can't contain one (the line didn't match). */
const isLineEnd = (c: string | undefined): boolean =>
	c === "\r" || c === "\u2028" || c === "\u2029";

/** `KEY <ws> = <ws> value <ws>` from index `i`: [key, value without the surrounding whitespace]. */
function keyValue(raw: string, i: number): [string, string] | null {
	const n = raw.length;
	if (i >= n || !KEY_START.test(raw[i] as string)) return null;
	let j = i + 1;
	while (j < n && KEY_CHAR.test(raw[j] as string)) j++;
	const key = raw.slice(i, j);
	while (isWs(raw[j])) j++;
	if (raw[j] !== "=") return null;
	j++;
	while (isWs(raw[j])) j++;
	let end = n;
	while (end > j && isWs(raw[end - 1])) end--;
	for (let k = j; k < end; k++) if (isLineEnd(raw[k])) return null;
	return [key, raw.slice(j, end)];
}

/** One .env line: leading whitespace, optional `export <ws>`, then KEY=value. */
function envLine(raw: string): [string, string] | null {
	let i = 0;
	while (isWs(raw[i])) i++;
	// `export K=v`; when the rest doesn't parse, `export` itself is the key (`export = v`)
	if (raw.startsWith("export", i) && isWs(raw[i + 6])) {
		let j = i + 6;
		while (isWs(raw[j])) j++;
		const kv = keyValue(raw, j);
		if (kv) return kv;
	}
	return keyValue(raw, i);
}

/** An unquoted value up to its comment: cut at the whitespace run before the first `#` that has one. */
function stripComment(v: string): string {
	for (let h = 1; h < v.length; h++) {
		if (v[h] !== "#" || !isWs(v[h - 1])) continue;
		let p = h - 1;
		while (p > 0 && isWs(v[p - 1])) p--;
		return v.slice(0, p);
	}
	return v;
}

/** `s` without its trailing `/`s (a backward scan, not /\/+$/ — see above). */
function trimTrailingSlashes(s: string): string {
	let end = s.length;
	while (end > 0 && s[end - 1] === "/") end--;
	return s.slice(0, end);
}

/** Minimal KEY=VALUE parser (comments, `export `, single/double quotes). Returns only `keys`. */
export function parseEnvFile(
	text: string,
	keys: readonly string[],
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const kv = envLine(raw);
		if (!kv || !keys.includes(kv[0])) continue;
		const [key, value] = kv;
		let v = value;
		const q = v[0];
		if ((q === '"' || q === "'") && v.endsWith(q) && v.length >= 2) {
			v = v.slice(1, -1);
		} else {
			v = stripComment(v);
		}
		out[key] = v;
	}
	return out;
}

const positive = (v: string | undefined, fallback: number) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

const nonNegative = (v: string | undefined, fallback: number) => {
	if (v === undefined || v.trim() === "") return fallback;
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** process.env wins over the checkout's .env. */
export function loadConfig(
	env: Record<string, string | undefined> = process.env,
	envPath: string = REPO_ENV_PATH,
): CollectorConfig {
	let file: Record<string, string> = {};
	try {
		if (existsSync(envPath))
			file = parseEnvFile(readFileSync(envPath, "utf8"), KEYS);
	} catch {
		// unreadable .env → defaults
	}
	const get = (k: Key) => env[k] || file[k] || undefined;
	return {
		hubUrl: trimTrailingSlashes(get("HUB_URL") ?? "http://127.0.0.1:4317"),
		ingestToken: get("INGEST_TOKEN") ?? null,
		machine: get("AGENTCITY_MACHINE") ?? "cockpit",
		home: get("AGENTCITY_HOME") ?? join(homedir(), ".agentcity"),
		hostname: hostname(),
		debug: !!get("AGENTCITY_DEBUG"),
		spoolLimits: {
			maxBytes: positive(get("SPOOL_MAX_MB"), 20) * 1024 * 1024,
			maxAgeMs: positive(get("SPOOL_MAX_AGE_DAYS"), 7) * 86_400_000,
		},
		codex: {
			sessionsDir:
				get("CODEX_SESSIONS_DIR") ?? join(homedir(), ".codex", "sessions"),
			backfillMs: nonNegative(get("CODEX_BACKFILL_HOURS"), 2) * 3_600_000,
			eventFilter: get("CODEX_BACKFILL_EVENT_FILTER") === "1",
		},
		usage: {
			enabled: get("AGENTCITY_USAGE") !== "0",
			claudeProjectsDir:
				get("AGENTCITY_CLAUDE_PROJECTS_DIR") ??
				join(homedir(), ".claude", "projects"),
		},
	};
}
