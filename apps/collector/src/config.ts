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
	"SPOOL_MAX_MB",
	"SPOOL_MAX_AGE_DAYS",
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
}

/** Minimal KEY=VALUE parser (comments, `export `, single/double quotes). Returns only `keys`. */
export function parseEnvFile(
	text: string,
	keys: readonly string[],
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(
			raw,
		);
		if (!m?.[1] || !keys.includes(m[1])) continue;
		let v = m[2] ?? "";
		const q = v[0];
		if ((q === '"' || q === "'") && v.endsWith(q) && v.length >= 2) {
			v = v.slice(1, -1);
		} else {
			v = v.replace(/\s+#.*$/, "");
		}
		out[m[1]] = v;
	}
	return out;
}

const positive = (v: string | undefined, fallback: number) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
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
		hubUrl: (get("HUB_URL") ?? "http://127.0.0.1:4317").replace(/\/+$/, ""),
		ingestToken: get("INGEST_TOKEN") ?? null,
		machine: get("AGENTCITY_MACHINE") ?? "cockpit",
		home: get("AGENTCITY_HOME") ?? join(homedir(), ".agentcity"),
		hostname: hostname(),
		debug: !!get("AGENTCITY_DEBUG"),
		spoolLimits: {
			maxBytes: positive(get("SPOOL_MAX_MB"), 20) * 1024 * 1024,
			maxAgeMs: positive(get("SPOOL_MAX_AGE_DAYS"), 7) * 86_400_000,
		},
	};
}
