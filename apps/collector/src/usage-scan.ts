// Token usage scanner (M1, 18 §5). Read-only on the tools' own logs; run by the resident collector
// (codex-tail.ts), never by the Claude hook.
//
// Sources (shapes in ~/Documents/AgentCityCaptures/usage/PROGRESS.md, U0):
//   Claude Code  <projects>/<cwd-slug>/<session>.jsonl and …/<session>/subagents/agent-*.jsonl
//                `type:"assistant"` lines: message.usage (+ usage.iterations[] advisor_message calls,
//                which the top-level usage leaves out). One API message is split over several
//                adjacent lines with the same message.id and the same usage → counted once.
//   Codex        <sessions>/YYYY/MM/DD/rollout-*.jsonl: session_meta (session, cwd), turn_context
//                (model), token_usage_record (one response's usage), event_msg/token_count rate_limits.
//
// What leaves this module: per (session, Sydney day, model) cumulative counts, the session's repo id,
// and Codex's own limit snapshots. Never a line's text, a cwd, a path or a parse error message.
//
// Bounded: at most PER_FILE_MAX bytes per file and TOTAL_MAX bytes per scan (newest files first; the
// rest is read on the next scans), at most MAX_FILES files, a substring filter before JSON.parse.
// Every file in the window is read from offset 0 (no EOF tailing): the hub keeps the larger value per
// column, so a total restarted from part of a file would hide later growth.
import {
	closeSync,
	type Dirent,
	openSync,
	readdirSync,
	readSync,
	statSync,
} from "node:fs";
import { basename, join, sep } from "node:path";
import {
	dayMinus,
	fnv1a64,
	parseGithubRemote,
	sessionId,
	tokenCount,
	USAGE_ROW_MAX,
	type UsageLimit,
	type UsageRow,
	type UsageTool,
	usageDay,
	usageLabel,
	usageObservedAt,
	usageProject,
} from "@agent-city/schema/core";
import type { GitInfo } from "./git-info.ts";

export const PER_FILE_MAX = 4 * 1024 * 1024;
export const TOTAL_MAX = 16 * 1024 * 1024;
export const MAX_FILES = 2_000;
/** Files modified within this window are read. */
export const USAGE_WINDOW_MS = 7 * 86_400_000;
/** Per-file totals are kept for this many days back (one more than the board shows). */
export const KEEP_DAYS = 8;
const MAX_STATE_FILES = 4_000;
const GIT_CACHE_MAX = 256;
const ITERATIONS_MAX = 64;

/** [input (not cached), output, cache read, cache write, messages] */
export type Totals = [number, number, number, number, number];

export interface UsageFile {
	tool: UsageTool;
	ino: number;
	offset: number;
	/** The rest of an over-long line is still ahead: drop bytes up to the next newline. */
	skip?: boolean;
	session: string | null;
	project: string | null;
	/** Codex: the model of the current turn (turn_context sits behind the offset after a restart). */
	model: string | null;
	/** Claude: fnv1a64 of the last counted message id (its repeats are adjacent). Never the raw id. */
	last_id: string | null;
	/** `${day}|${model}` → totals of this file. */
	totals: Record<string, Totals>;
	mtime: number;
}

export interface UsageState {
	v: 1;
	files: Record<string, UsageFile>;
	/** Sessions whose rows the hub has not acknowledged yet. */
	dirty: string[];
	/** `${tool}|${limit_id}|${window}` → newest snapshot. */
	limits: Record<string, UsageLimit>;
	limits_dirty: boolean;
	/**
	 * Claude message ids already counted, across files: fnv1a64(id) → `${fnv1a64(path)}|${day}`. A resumed
	 * or forked transcript replays earlier messages into a new file; they count once, in the file read
	 * first. Pruned with the days.
	 */
	seen?: Record<string, string>;
}

export const emptyUsageState = (): UsageState => ({
	v: 1,
	files: {},
	dirty: [],
	limits: {},
	limits_dirty: false,
	seen: {},
});

export interface ScanDeps {
	git: (cwd: string) => GitInfo | null;
}

export interface ScanOptions {
	claudeRoot: string | null;
	codexRoot: string | null;
	state: UsageState;
	now: number;
	deps: ScanDeps;
	perFileMax?: number;
	totalMax?: number;
}

export interface ScanResult {
	bytes: number;
	/** Some file still has unread bytes (the budget ran out): scan again soon. */
	backlog: boolean;
	files: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null =>
	typeof v === "string" && v.length > 0 ? v : null;

/** *.jsonl under `root` (depth ≤ 4) modified at or after `since`, newest first, at most MAX_FILES. */
export function listUsageFiles(
	root: string,
	since: number,
): { path: string; mtime: number }[] {
	const out: { path: string; mtime: number }[] = [];
	const walk = (dir: string, depth: number) => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDirectory() && depth < 4) walk(p, depth + 1);
			else if (e.isFile() && e.name.endsWith(".jsonl")) {
				try {
					const m = statSync(p).mtimeMs;
					if (m >= since) out.push({ path: p, mtime: m });
				} catch {
					// vanished
				}
			}
		}
	};
	walk(root, 0);
	out.sort(byNewest);
	return out.slice(0, MAX_FILES);
}

const byNewest = (
	a: { path: string; mtime: number },
	b: { path: string; mtime: number },
) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function readRange(path: string, from: number, max: number): Buffer {
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(max);
		const n = readSync(fd, buf, 0, max, from);
		return buf.subarray(0, n);
	} finally {
		closeSync(fd);
	}
}

type Resolve = (cwd: string | null) => string | null;

/** cwd → repo id, cached per scan (gitInfo reads .git files; a cwd's answer rarely changes). */
function projectResolver(deps: ScanDeps): Resolve {
	const cache = new Map<string, string | null>();
	return (cwd) => {
		if (!cwd) return null;
		const hit = cache.get(cwd);
		if (hit !== undefined) return hit;
		let id: string | null = null;
		try {
			id = usageProject(deps.git(cwd)?.repo_id ?? null);
		} catch {
			id = null;
		}
		if (cache.size >= GIT_CACHE_MAX) {
			const first = cache.keys().next().value;
			if (first !== undefined) cache.delete(first);
		}
		cache.set(cwd, id);
		return id;
	};
}

function add(file: UsageFile, day: string, model: string, t: Totals): void {
	const key = `${day}|${model}`;
	const cur = file.totals[key] ?? [0, 0, 0, 0, 0];
	for (let i = 0; i < 5; i++) cur[i] = (cur[i] as number) + (t[i] as number);
	file.totals[key] = cur;
}

const modelOf = (v: unknown): string => usageLabel(v) ?? "unknown";

/** One Claude transcript line. Returns true when it added usage. */
function claudeLine(
	line: string,
	file: UsageFile,
	project: Resolve,
	seen: Record<string, string>,
	pathKey: string,
): boolean {
	if (!line.includes('"usage"') || !line.includes('"assistant"')) return false;
	let r: Obj;
	try {
		const parsed = JSON.parse(line);
		if (!isObj(parsed)) return false;
		r = parsed;
	} catch {
		return false;
	}
	if (r.type !== "assistant" || !isObj(r.message)) return false;
	const m = r.message;
	const u = m.usage;
	if (!isObj(u)) return false;
	const raw = str(m.id) ?? str(r.requestId);
	const id = raw === null ? null : fnv1a64(raw);
	if (id !== null && id === file.last_id) return false; // same message, next content block
	const day = usageDay(str(r.timestamp) ?? "");
	if (!day) return false;
	if (id !== null) {
		file.last_id = id;
		const first = seen[id];
		if (first !== undefined && !first.startsWith(`${pathKey}|`)) return false; // replayed
		if (first === undefined) seen[id] = `${pathKey}|${day}`;
	}
	if (!file.session) {
		const raw = str(r.sessionId);
		if (raw) file.session = sessionId("claude", raw);
	}
	const p = project(str(r.cwd));
	if (p) file.project = p;
	let added = false;
	const own: Totals = [
		tokenCount(u.input_tokens),
		tokenCount(u.output_tokens),
		tokenCount(u.cache_read_input_tokens),
		tokenCount(u.cache_creation_input_tokens),
		1,
	];
	if (own[0] + own[1] + own[2] + own[3] > 0) {
		add(file, day, modelOf(m.model), own);
		added = true;
	}
	if (Array.isArray(u.iterations)) {
		for (const it of u.iterations.slice(0, ITERATIONS_MAX)) {
			if (!isObj(it) || it.type !== "advisor_message") continue;
			add(file, day, modelOf(it.model), [
				tokenCount(it.input_tokens),
				tokenCount(it.output_tokens),
				tokenCount(it.cache_read_input_tokens),
				tokenCount(it.cache_creation_input_tokens),
				1,
			]);
			added = true;
		}
	}
	return added;
}

const CODEX_KEYS = [
	'"session_meta"',
	'"turn_context"',
	'"token_usage_record"',
	'"rate_limits"',
];

/** Codex `rate_limits` → the snapshots it states (primary / secondary windows). */
function codexLimits(rl: Obj, observed: string): UsageLimit[] {
	const out: UsageLimit[] = [];
	const id = usageLabel(rl.limit_id) ?? "default";
	for (const w of [rl.primary, rl.secondary]) {
		if (!isObj(w)) continue;
		const pct = w.used_percent;
		const win = w.window_minutes;
		if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
		if (
			typeof win !== "number" ||
			!Number.isInteger(win) ||
			win <= 0 ||
			win > 1_000_000
		)
			continue;
		let resets: string | null = null;
		if (
			typeof w.resets_at === "number" &&
			Number.isFinite(w.resets_at) &&
			w.resets_at > 0 &&
			w.resets_at < 1e11
		)
			resets = new Date(w.resets_at * 1000).toISOString();
		out.push({
			tool: "codex",
			limit_id: id,
			window_minutes: win,
			used_percent: Math.min(Math.max(pct, 0), 1000),
			resets_at: resets,
			plan_type: usageLabel(rl.plan_type),
			observed_at: observed,
		});
	}
	return out;
}

/** One Codex rollout line. Returns true when it added usage. */
function codexLine(
	line: string,
	file: UsageFile,
	project: Resolve,
	onLimit: (l: UsageLimit) => void,
): boolean {
	if (!CODEX_KEYS.some((k) => line.includes(k))) return false;
	let r: Obj;
	try {
		const parsed = JSON.parse(line);
		if (!isObj(parsed)) return false;
		r = parsed;
	} catch {
		return false;
	}
	const p = isObj(r.payload) ? r.payload : {};
	if (r.type === "session_meta") {
		// Same rule as codex-map.ts: a subagent thread's file names its parent in session_id.
		const raw = str(p.session_id) ?? str(p.id);
		if (raw) file.session = sessionId("codex", raw);
		const remote = isObj(p.git) ? str(p.git.repository_url) : null;
		file.project =
			project(str(p.cwd)) ??
			usageProject(remote ? parseGithubRemote(remote) : null) ??
			file.project;
		return false;
	}
	if (r.type === "turn_context") {
		const m = usageLabel(p.model);
		if (m) file.model = m;
		const proj = project(str(p.cwd));
		if (proj) file.project = proj;
		return false;
	}
	const ts = str(r.timestamp);
	if (r.type === "token_usage_record") {
		if (!file.session || !isObj(p.usage)) return false;
		const day = usageDay(ts ?? "");
		if (!day) return false;
		const u = p.usage;
		const input = tokenCount(u.input_tokens);
		const cached = Math.min(tokenCount(u.cached_input_tokens), input);
		add(file, day, file.model ?? "unknown", [
			input - cached,
			tokenCount(u.output_tokens),
			cached,
			tokenCount(u.cache_write_input_tokens),
			1,
		]);
		return true;
	}
	if (
		r.type === "event_msg" &&
		p.type === "token_count" &&
		isObj(p.rate_limits)
	) {
		const ms = ts ? Date.parse(ts) : Number.NaN;
		if (!Number.isFinite(ms)) return false;
		for (const l of codexLimits(p.rate_limits, new Date(ms).toISOString()))
			onLimit(l);
	}
	return false;
}

/**
 * A Claude transcript's session from its path: `<dir>/<session>.jsonl`, or
 * `<dir>/<session>/subagents/<agent>.jsonl` (a subagent belongs to its parent). Null for other shapes
 * (the first line's sessionId is used then).
 */
export function claudeSessionFromPath(path: string): string | null {
	const parts = path.split(sep);
	const name = basename(path, ".jsonl");
	const raw = parts.at(-2) === "subagents" ? (parts.at(-3) ?? null) : name;
	return raw ? sessionId("claude", raw) : null;
}

const freshFile = (
	tool: UsageTool,
	ino: number,
	mtime: number,
	path: string,
): UsageFile => ({
	tool,
	ino,
	offset: 0,
	session: tool === "claude" ? claudeSessionFromPath(path) : null,
	project: null,
	model: null,
	last_id: null,
	totals: {},
	mtime,
});

/**
 * Read what is new in every usage file and fold it into `state` (mutated in place; save it after).
 * Sessions that gained usage are added to `state.dirty`. Never throws for a bad file or line.
 */
export function scanUsage(opts: ScanOptions): ScanResult {
	const { state } = opts;
	const perFileMax = opts.perFileMax ?? PER_FILE_MAX;
	let budget = opts.totalMax ?? TOTAL_MAX;
	const project = projectResolver(opts.deps);
	const dirty = new Set(state.dirty);
	const cutoff = dayMinus(usageDay(opts.now) ?? "1970-01-01", KEEP_DAYS);
	const minObserved = opts.now - KEEP_DAYS * 86_400_000;
	if (!state.seen) state.seen = {};
	const seenIds = state.seen;
	const onLimit = (l: UsageLimit) => {
		const observed = usageObservedAt(l.observed_at, opts.now);
		if (observed === null || Date.parse(observed) < minObserved) return;
		l.observed_at = observed;
		const key = `${l.tool}|${l.limit_id}|${l.window_minutes}`;
		const cur = state.limits[key];
		if (cur && Date.parse(cur.observed_at) >= Date.parse(l.observed_at)) return;
		state.limits[key] = l;
		state.limits_dirty = true;
	};

	const since = opts.now - USAGE_WINDOW_MS;
	const listed: { path: string; mtime: number; tool: UsageTool }[] = [];
	if (opts.claudeRoot)
		for (const f of listUsageFiles(opts.claudeRoot, since))
			listed.push({ ...f, tool: "claude" });
	if (opts.codexRoot)
		for (const f of listUsageFiles(opts.codexRoot, since))
			listed.push({ ...f, tool: "codex" });
	listed.sort(byNewest);

	let bytes = 0;
	let backlog = false;
	const seen = new Set<string>();
	for (const { path, tool, mtime } of listed.slice(0, MAX_FILES)) {
		seen.add(path);
		let size: number;
		let ino: number;
		try {
			const st = statSync(path);
			size = st.size;
			ino = st.ino;
		} catch {
			continue;
		}
		let file = state.files[path];
		if (!file || file.tool !== tool || file.ino !== ino || size < file.offset) {
			// new, rotated or truncated → read it again from the start
			if (file?.session) dirty.add(file.session);
			file = freshFile(tool, ino, mtime, path);
			state.files[path] = file;
		}
		file.mtime = mtime;
		if (size <= file.offset) continue;
		if (budget <= 0) {
			backlog = true;
			continue;
		}
		let buf: Buffer;
		try {
			buf = readRange(
				path,
				file.offset,
				Math.min(perFileMax, budget, size - file.offset),
			);
		} catch {
			continue;
		}
		budget -= buf.length;
		bytes += buf.length;
		const pathKey = fnv1a64(path);
		let pos = 0;
		if (file.skip) {
			const nl = buf.indexOf(0x0a);
			if (nl === -1) {
				file.offset += buf.length;
				if (file.offset < size) backlog = true;
				continue;
			}
			pos = nl + 1;
			file.skip = false;
		}
		let added = false;
		for (;;) {
			const nl = buf.indexOf(0x0a, pos);
			if (nl === -1) break; // partial trailing line: wait for the rest
			if (nl > pos) {
				const line = buf.subarray(pos, nl).toString("utf8");
				const got =
					tool === "claude"
						? claudeLine(line, file, project, seenIds, pathKey)
						: codexLine(line, file, project, onLimit);
				if (got) added = true;
			}
			pos = nl + 1;
		}
		if (pos === 0 && buf.length === perFileMax) {
			// one line longer than a whole read: skip it (never parse a fragment)
			pos = buf.length;
			file.skip = true;
		}
		file.offset += pos;
		if (file.offset < size) backlog = true;
		if (added && file.session) dirty.add(file.session);
	}

	// Forget old days, and files that left the window once nothing they hold is recent.
	for (const [path, file] of Object.entries(state.files)) {
		for (const key of Object.keys(file.totals))
			if (key.slice(0, 10) < cutoff) delete file.totals[key];
		if (!seen.has(path) && Object.keys(file.totals).length === 0)
			delete state.files[path];
	}
	const paths = Object.keys(state.files);
	if (paths.length > MAX_STATE_FILES) {
		const oldest = paths
			.sort(
				(a, b) => (state.files[a]?.mtime ?? 0) - (state.files[b]?.mtime ?? 0),
			)
			.slice(0, paths.length - MAX_STATE_FILES);
		for (const p of oldest) delete state.files[p];
	}
	for (const [key, l] of Object.entries(state.limits))
		if (Date.parse(l.observed_at) < minObserved) delete state.limits[key];
	for (const [id, v] of Object.entries(seenIds))
		if (v.slice(-10) < cutoff) delete seenIds[id];
	const live = new Set<string>();
	for (const f of Object.values(state.files))
		if (f.session) live.add(f.session);
	state.dirty = [...dirty].filter((s) => live.has(s));
	return { bytes, backlog, files: seen.size };
}

/**
 * Rows for the given sessions: every file of a session (main transcript + subagents) summed per
 * (day, model). The session's project is the first one known in path order (the main file sorts first).
 */
export function usageRows(
	state: UsageState,
	sessions: Iterable<string>,
): UsageRow[] {
	const wanted = new Set(sessions);
	const bySession = new Map<
		string,
		{ tool: UsageTool; project: string | null; totals: Map<string, Totals> }
	>();
	for (const path of Object.keys(state.files).sort()) {
		const f = state.files[path];
		if (!f?.session || !wanted.has(f.session)) continue;
		let s = bySession.get(f.session);
		if (!s) {
			s = { tool: f.tool, project: null, totals: new Map() };
			bySession.set(f.session, s);
		}
		s.project ??= f.project;
		for (const [key, t] of Object.entries(f.totals)) {
			const cur = s.totals.get(key) ?? [0, 0, 0, 0, 0];
			for (let i = 0; i < 5; i++)
				cur[i] = (cur[i] as number) + (t[i] as number);
			s.totals.set(key, cur);
		}
	}
	const rows: UsageRow[] = [];
	for (const [session_id, s] of bySession) {
		for (const [key, t] of s.totals) {
			const bar = key.indexOf("|");
			rows.push({
				session_id,
				day: key.slice(0, bar),
				model: key.slice(bar + 1),
				tool: s.tool,
				project: s.project,
				input_tokens: Math.min(t[0], USAGE_ROW_MAX),
				output_tokens: Math.min(t[1], USAGE_ROW_MAX),
				cache_read_tokens: Math.min(t[2], USAGE_ROW_MAX),
				cache_write_tokens: Math.min(t[3], USAGE_ROW_MAX),
				messages: Math.min(t[4], USAGE_ROW_MAX),
			});
		}
	}
	return rows;
}
