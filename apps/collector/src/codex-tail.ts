// `bun run collector:codex` — resident tailer for Codex rollout logs (~/.codex/sessions/**.jsonl).
// Read-only on Codex files; never touches ~/.codex config.
//
// - polls every second; only files modified in the last 7 days are considered
// - byte offsets + per-file session context persist in ~/.agentcity/codex-offsets.json, so a
//   restart resumes without duplicates (event ids are also deterministic: codex:<session>:<offset>)
// - a partial trailing line is never consumed; inode change / truncation → start over
// - first sight of a file whose MTIME is older than CODEX_BACKFILL_HOURS (default 2): only line 1
//   (session_meta) is read, then it's tailed from EOF — no flood of months-old history. A file with a
//   fresh mtime is read in full, even records older than the window, unless
//   CODEX_BACKFILL_EVENT_FILTER=1 (then those are skipped by their own timestamp; F14)
// - a bad line is skipped, never fatal
// - offsets are committed only after the events are delivered or durably spooled (F06): pollOnce
//   works on copies and returns `commit()`; a failed delivery re-reads the same lines next tick
//   (same deterministic ids → the hub dedupes)
// - call_id → tool name survives across polls for the life of the process (F11)
import {
	closeSync,
	type Dirent,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { IngestEvent } from "@agent-city/schema/core";
import {
	type CodexFileContext,
	type CodexMapDeps,
	type CodexSession,
	mapCodexLine,
} from "./codex-map.ts";
import { loadConfig } from "./config.ts";
import { gitInfo } from "./git-info.ts";
import { createTransport, deliver, Spool } from "./spool.ts";

const MAX_READ = 4 * 1024 * 1024; // per file per poll
const FIRST_LINE_MAX = 512 * 1024; // session_meta embeds long instructions
export const MAX_AGE_MS = 7 * 86_400_000;

export interface FileState {
	offset: number;
	ino: number;
	session: CodexSession | null;
	/** Records older than this (ISO) are skipped — set on first sight with the event filter (F14). */
	min_ts?: string;
}
export interface TailState {
	files: Record<string, FileState>;
}

export function loadState(path: string): TailState {
	try {
		const s = JSON.parse(readFileSync(path, "utf8")) as TailState;
		if (s && typeof s.files === "object") return s;
	} catch {
		// missing / corrupt → fresh
	}
	return { files: {} };
}

export function saveState(path: string, state: TailState): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
	renameSync(tmp, path);
}

/** All *.jsonl under root with mtime ≥ `since`. */
export function listRolloutFiles(root: string, since: number): string[] {
	const out: string[] = [];
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
					if (statSync(p).mtimeMs >= since) out.push(p);
				} catch {
					// vanished
				}
			}
		}
	};
	walk(root, 0);
	return out.sort();
}

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

/**
 * Committed per-file call_id → tool maps, kept across polls (F11; not persisted — a restart only
 * loses names). A poll works on a copy that commit() swaps in, so a failed delivery re-reads its
 * lines against the same map it started from.
 */
const CALLS = new WeakMap<TailState, Map<string, Map<string, string>>>();
function callsOf(state: TailState): Map<string, Map<string, string>> {
	let byFile = CALLS.get(state);
	if (!byFile) {
		byFile = new Map();
		CALLS.set(state, byFile);
	}
	return byFile;
}

/** Events from one poll; `commit()` applies the new offsets to the state (call after delivery). */
export type PollResult = IngestEvent[] & { commit(): void };

export interface PollOptions {
	root: string;
	state: TailState;
	now: number;
	backfillMs: number;
	/**
	 * F14: the backfill window is by file mtime. With this on, a file first seen with a fresh mtime
	 * also skips records whose own timestamp is older than the window (an old session resumed today).
	 */
	eventFilter?: boolean;
	maxAgeMs?: number;
	deps: CodexMapDeps;
}

/**
 * Read everything new and map it to events. `state` is NOT modified until the returned `commit()` is
 * called — deliver first, then commit, then saveState.
 */
export function pollOnce(opts: PollOptions): PollResult {
	const events: IngestEvent[] = [];
	const next: Record<string, FileState> = {};
	const committedCalls = callsOf(opts.state);
	const nextCalls = new Map<string, Map<string, string>>();
	for (const path of listRolloutFiles(
		opts.root,
		opts.now - (opts.maxAgeMs ?? MAX_AGE_MS),
	)) {
		let st: Stats;
		try {
			st = statSync(path);
		} catch {
			continue;
		}
		const committed = opts.state.files[path];
		let file: FileState | undefined = committed
			? {
					...committed,
					session: committed.session ? { ...committed.session } : null,
				}
			: undefined;
		let restart = false;
		if (file && (file.ino !== st.ino || st.size < file.offset)) {
			file = undefined; // rotated / truncated → start over, forget its calls
			restart = true;
		}

		if (!file) {
			file = { offset: 0, ino: st.ino, session: null };
			if (opts.eventFilter)
				file.min_ts = new Date(opts.now - opts.backfillMs).toISOString();
			if (st.mtimeMs < opts.now - opts.backfillMs) {
				// old file: learn the session from line 1, then tail from EOF
				const ctx: CodexFileContext = { session: null, calls: new Map() };
				const head = readRange(
					path,
					0,
					Math.min(FIRST_LINE_MAX, st.size),
				).toString("utf8");
				const nl = head.indexOf("\n");
				if (nl > 0) mapCodexLine(head.slice(0, nl), 0, ctx, opts.deps);
				file.session = ctx.session;
				file.offset = st.size;
				next[path] = file;
				nextCalls.set(path, ctx.calls);
				continue;
			}
		}
		if (st.size <= file.offset) {
			next[path] = file;
			if (restart) nextCalls.set(path, new Map());
			continue;
		}
		const ctx: CodexFileContext = {
			session: file.session,
			calls: new Map(restart ? [] : committedCalls.get(path)),
		};
		const minTs = file.min_ts ? Date.parse(file.min_ts) : null;

		const buf = readRange(
			path,
			file.offset,
			Math.min(MAX_READ, st.size - file.offset),
		);
		let pos = 0;
		for (;;) {
			const nl = buf.indexOf(0x0a, pos);
			if (nl === -1) break; // partial trailing line: wait for the rest
			const line = buf.subarray(pos, nl).toString("utf8").trim();
			const lineOffset = file.offset + pos;
			pos = nl + 1;
			if (!line) continue;
			// mapped even when too old: session_meta / turn_context still update the context
			const ev = mapCodexLine(line, lineOffset, ctx, opts.deps);
			if (ev && !(minTs !== null && Date.parse(ev.ts) < minTs)) events.push(ev);
		}
		if (pos === 0 && buf.length === MAX_READ) pos = buf.length; // one giant line: skip, don't stall
		file.offset += pos;
		file.session = ctx.session;
		next[path] = file;
		nextCalls.set(path, ctx.calls);
	}
	const gone = Object.keys(opts.state.files).filter((p) => !existsSync(p));
	const state = opts.state;
	return Object.defineProperty(events, "commit", {
		enumerable: false,
		value: () => {
			Object.assign(state.files, next);
			for (const [p, calls] of nextCalls) committedCalls.set(p, calls);
			for (const p of gone) {
				delete state.files[p];
				committedCalls.delete(p);
			}
		},
	}) as PollResult;
}

if (import.meta.main) {
	const cfg = loadConfig();
	const root = cfg.codex.sessionsDir;
	const { backfillMs, eventFilter } = cfg.codex;
	const statePath = join(cfg.home, "codex-offsets.json");
	mkdirSync(cfg.home, { recursive: true, mode: 0o700 });

	const state = loadState(statePath);
	const spool = new Spool(cfg.home, cfg.spoolLimits);
	const transport = createTransport(cfg, 5_000);
	const deps: CodexMapDeps = {
		machine: cfg.machine,
		hostname: cfg.hostname,
		git: gitInfo,
	};
	console.log(
		`[codex-tail] watching ${root} → ${cfg.hubUrl} (machine ${cfg.machine}, backfill ${backfillMs / 3_600_000}h, ingest token ${cfg.ingestToken ? "set" : "MISSING — events will spool"})`,
	);

	let lastFlush = 0;
	let busy = false;
	const tick = async () => {
		if (busy) return;
		busy = true;
		try {
			const events = pollOnce({
				root,
				state,
				now: Date.now(),
				backfillMs,
				eventFilter,
				deps,
			});
			if (events.length) {
				const outcome = await deliver(events, spool, transport);
				console.log(`[codex-tail] ${events.length} events ${outcome}`);
				if (outcome === "failed") return; // not durable → don't commit; re-read next tick
			} else if (Date.now() - lastFlush > 5_000 && spool.pending()) {
				// also drains what Claude hooks spooled while the hub was down
				const r = await spool.flush(transport);
				if (r.sent || r.rejected)
					console.log(
						`[codex-tail] spool: ${r.sent} sent, ${r.rejected} rejected`,
					);
				lastFlush = Date.now();
			}
			events.commit(); // delivered or durably spooled
			saveState(statePath, state);
		} catch (err) {
			console.error(`[codex-tail] ${(err as Error).message}`);
		} finally {
			busy = false;
		}
	};
	await tick();
	setInterval(tick, 1_000);
}
