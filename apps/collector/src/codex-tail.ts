// `bun run collector:codex` — resident tailer for Codex rollout logs (~/.codex/sessions/**.jsonl).
// Read-only on Codex files; never touches ~/.codex config.
//
// - polls every second; only files modified in the last 7 days are considered
// - byte offsets + per-file session context persist in ~/.agentcity/codex-offsets.json, so a
//   restart resumes without duplicates (event ids are also deterministic: codex:<session>:<offset>)
// - a partial trailing line is never consumed; inode change / truncation → start over
// - first sight of a file older than CODEX_BACKFILL_HOURS (default 2): only line 1 (session_meta)
//   is read, then it's tailed from EOF — no flood of months-old history
// - a bad line is skipped, never fatal; delivery = POST or spool, then state is saved
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
import { homedir } from "node:os";
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

export interface PollOptions {
	root: string;
	state: TailState;
	now: number;
	backfillMs: number;
	maxAgeMs?: number;
	deps: CodexMapDeps;
}

/** Read everything new, map to events, advance offsets in `state` (caller persists after delivery). */
export function pollOnce(opts: PollOptions): IngestEvent[] {
	const events: IngestEvent[] = [];
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
		let file = opts.state.files[path];
		if (file && (file.ino !== st.ino || st.size < file.offset))
			file = undefined; // rotated / truncated → start over
		const ctx: CodexFileContext = {
			session: file?.session ?? null,
			calls: new Map(),
		};

		if (!file) {
			file = { offset: 0, ino: st.ino, session: null };
			if (st.mtimeMs < opts.now - opts.backfillMs) {
				// old file: learn the session from line 1, then tail from EOF
				const head = readRange(
					path,
					0,
					Math.min(FIRST_LINE_MAX, st.size),
				).toString("utf8");
				const nl = head.indexOf("\n");
				if (nl > 0) mapCodexLine(head.slice(0, nl), 0, ctx, opts.deps);
				file.session = ctx.session;
				file.offset = st.size;
				opts.state.files[path] = file;
				continue;
			}
		}
		if (st.size <= file.offset) {
			opts.state.files[path] = file;
			continue;
		}

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
			const ev = mapCodexLine(line, lineOffset, ctx, opts.deps);
			if (ev) events.push(ev);
		}
		if (pos === 0 && buf.length === MAX_READ) pos = buf.length; // one giant line: skip, don't stall
		file.offset += pos;
		file.session = ctx.session;
		opts.state.files[path] = file;
	}
	for (const p of Object.keys(opts.state.files)) {
		if (!existsSync(p)) delete opts.state.files[p];
	}
	return events;
}

if (import.meta.main) {
	const cfg = loadConfig();
	const root =
		process.env.CODEX_SESSIONS_DIR || join(homedir(), ".codex", "sessions");
	const backfillMs = Number(process.env.CODEX_BACKFILL_HOURS || 2) * 3_600_000;
	const statePath = join(cfg.home, "codex-offsets.json");
	mkdirSync(cfg.home, { recursive: true, mode: 0o700 });

	const state = loadState(statePath);
	const spool = new Spool(cfg.home);
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
				deps,
			});
			if (events.length) {
				const outcome = await deliver(events, spool, transport);
				console.log(`[codex-tail] ${events.length} events ${outcome}`);
			} else if (Date.now() - lastFlush > 5_000 && spool.pending()) {
				// also drains what Claude hooks spooled while the hub was down
				const r = await spool.flush(transport);
				if (r.sent || r.rejected)
					console.log(
						`[codex-tail] spool: ${r.sent} sent, ${r.rejected} rejected`,
					);
				lastFlush = Date.now();
			}
			saveState(statePath, state); // after delivery (sent or spooled)
		} catch (err) {
			console.error(`[codex-tail] ${(err as Error).message}`);
		} finally {
			busy = false;
		}
	};
	await tick();
	setInterval(tick, 1_000);
}
