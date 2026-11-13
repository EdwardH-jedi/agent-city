// Token usage poller (M1, 18 §5): runs inside the resident Codex tailer (`bun run collector:codex`),
// on its own timer and its own error handling, so it can never stall or break the event tail.
//
// - every USAGE_POLL_MS (USAGE_BACKLOG_MS while a first read is still catching up) it scans the
//   Claude transcripts and Codex rollouts (usage-scan.ts, bounded) and saves the offsets/totals to
//   ~/.agentcity/usage-offsets.json (files keyed by a hash of their path: no path is written)
// - then it POSTs the cumulative rows of every session that changed to /ingest/usage, in chunks that fit
//   the hub's row and byte caps (a refused chunk is split; only a single refused row is dropped). A failed send
//   is not spooled: the rows stay marked and are sent again next time (they are totals, so nothing
//   is lost and a repeat changes nothing at the hub)
// - on start every known session is marked, so a restart re-sends what the hub may have missed
// - logs carry counts and HTTP status only — never a line, a path from a log, or an error message
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	USAGE_MAX_BODY_BYTES,
	USAGE_MAX_LIMITS,
	USAGE_MAX_ROWS,
	type UsageLimit,
	type UsageRow,
} from "@agent-city/schema/core";
import type { CollectorConfig } from "./config.ts";
import { gitInfo } from "./git-info.ts";
import {
	emptyUsageState,
	type ScanDeps,
	scanUsage,
	USAGE_BACKFILL_VERSION,
	type UsageBackfill,
	type UsageFile,
	type UsageState,
	usageRows,
} from "./usage-scan.ts";

export const USAGE_POLL_MS = 60_000;
export const USAGE_BACKLOG_MS = 5_000;
const SEND_TIMEOUT_MS = 10_000;
const MACHINES = new Set(["cockpit", "forge", "spine"]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** A saved file entry is used only when every field has its type; otherwise that file is read again. */
function validFile(f: unknown): f is UsageFile {
	if (!isRecord(f)) return false;
	const strOrNull = (v: unknown) => v === null || typeof v === "string";
	return (
		(f.tool === "claude" || f.tool === "codex") &&
		Number.isFinite(f.birth) &&
		Number.isFinite(f.ino) &&
		Number.isInteger(f.offset) &&
		(f.offset as number) >= 0 &&
		Number.isFinite(f.mtime) &&
		strOrNull(f.session) &&
		strOrNull(f.project) &&
		strOrNull(f.model) &&
		strOrNull(f.last_id) &&
		(f.ctotal === undefined ||
			(typeof f.ctotal === "number" && Number.isFinite(f.ctotal))) &&
		(f.rec === undefined || typeof f.rec === "boolean") &&
		isRecord(f.totals) &&
		Object.values(f.totals).every(
			(t) =>
				Array.isArray(t) &&
				t.length === 5 &&
				t.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0),
		)
	);
}

function validBackfill(b: unknown): b is UsageBackfill {
	return (
		isRecord(b) &&
		b.v === USAGE_BACKFILL_VERSION &&
		(b.done === null ||
			(typeof b.done === "string" && Number.isFinite(Date.parse(b.done)))) &&
		Number.isInteger(b.files) &&
		Number.isInteger(b.cut)
	);
}

/**
 * The saved state, checked entry by entry (a damaged entry is dropped and that file read again; the hub
 * keeps the larger values, so nothing is lost). Missing or unreadable → fresh.
 *
 * A state without this USAGE_BACKFILL_VERSION's backfill mark (written before U4, or by another version)
 * keeps only its limits: its files had already forgotten their old days, so every file is read again
 * from the start by the backfill. A backfill that was still running resumes where it stopped. A state of
 * the path-keyed format (v 1, before 18 §9.7 P2-3) also keeps only its limits.
 */
export function loadUsageState(path: string): UsageState {
	const state = emptyUsageState();
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return state;
	}
	if (!isRecord(raw) || (raw.v !== 1 && raw.v !== 2)) return state;
	if (isRecord(raw.limits))
		for (const [k, l] of Object.entries(raw.limits))
			if (UsageLimitShape(l)) state.limits[k] = l;
	if (raw.v !== 2 || !validBackfill(raw.backfill)) return state;
	state.backfill = raw.backfill;
	if (isRecord(raw.files))
		for (const [p, f] of Object.entries(raw.files))
			if (validFile(f)) state.files[p] = f;
	if (Array.isArray(raw.dirty))
		state.dirty = raw.dirty.filter((d): d is string => typeof d === "string");
	if (isRecord(raw.seen))
		for (const [k, v] of Object.entries(raw.seen))
			if (typeof v === "string" && state.seen) state.seen[k] = v;
	return state;
}

function UsageLimitShape(l: unknown): l is UsageLimit {
	return (
		isRecord(l) &&
		(l.tool === "claude" || l.tool === "codex") &&
		typeof l.limit_id === "string" &&
		Number.isInteger(l.window_minutes) &&
		typeof l.used_percent === "number" &&
		typeof l.observed_at === "string"
	);
}

export function saveUsageState(path: string, state: UsageState): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
	renameSync(tmp, path);
}

/** Mark every session the state knows (and the limits) for sending — used once at start. */
export function markAll(state: UsageState): void {
	const all = new Set(state.dirty);
	for (const f of Object.values(state.files)) if (f.session) all.add(f.session);
	state.dirty = [...all];
	if (Object.keys(state.limits).length > 0) state.limits_dirty = true;
}

interface Chunk {
	sessions: string[];
	rows: UsageRow[];
}

/**
 * Sessions packed whole into chunks of ≤ USAGE_MAX_ROWS rows and ≤ `rowBytes` bytes of rows (the JSON
 * array's UTF-8 bytes; the caller leaves room for the envelope). A session too big for one chunk is split.
 */
export function chunkRows(
	state: UsageState,
	sessions: readonly string[],
	rowBytes = USAGE_MAX_BODY_BYTES - 4096,
): Chunk[] {
	const out: Chunk[] = [];
	let cur: Chunk = { sessions: [], rows: [] };
	let bytes = 0;
	const next = () => {
		out.push(cur);
		cur = { sessions: [], rows: [] };
		bytes = 0;
	};
	for (const s of [...sessions].sort()) {
		const rows = usageRows(state, [s]);
		// each row costs its JSON plus a comma
		const sizes = rows.map((r) => Buffer.byteLength(JSON.stringify(r)) + 1);
		const all = sizes.reduce((n, b) => n + b, 0);
		if (
			cur.rows.length > 0 &&
			(cur.rows.length + rows.length > USAGE_MAX_ROWS || bytes + all > rowBytes)
		)
			next();
		rows.forEach((r, i) => {
			const b = sizes[i] as number;
			if (
				cur.rows.length > 0 &&
				(cur.rows.length >= USAGE_MAX_ROWS || bytes + b > rowBytes)
			)
				next();
			cur.rows.push(r);
			bytes += b;
		});
		cur.sessions.push(s); // cleared only once the chunk holding its last rows is accepted
	}
	if (cur.rows.length > 0 || cur.sessions.length > 0) out.push(cur);
	return out;
}

export interface SendOutcome {
	posted: number;
	rows: number;
	/** HTTP status of the first failed POST, `0` for a network error, -1 bad machine, null = all ok. */
	failed: number | null;
}

/**
 * POST the dirty sessions' rows (and the limits when they changed), in chunks cut by row count and by
 * the body's UTF-8 bytes (envelope and limits included) to fit USAGE_MAX_BODY_BYTES. A chunk the hub
 * refuses (400/413) is split in half and sent again; only a single row the hub still refuses is dropped
 * (limits riding along are tried apart first). Clears what the hub accepted. Never throws.
 */
export async function sendUsage(
	cfg: Pick<CollectorConfig, "hubUrl" | "ingestToken" | "machine">,
	state: UsageState,
	fetchImpl: typeof fetch = fetch,
): Promise<SendOutcome> {
	const result: SendOutcome = { posted: 0, rows: 0, failed: null };
	if (!MACHINES.has(cfg.machine)) return { ...result, failed: -1 };
	let limits: UsageLimit[] = state.limits_dirty
		? Object.values(state.limits)
				.sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at))
				.slice(0, USAGE_MAX_LIMITS)
		: [];
	const body = (rows: UsageRow[], lims: UsageLimit[]) =>
		JSON.stringify({ schema: 1, machine_id: cfg.machine, rows, limits: lims });
	// every chunk leaves room for the limits, which ride on the first one sent
	const envelope = Buffer.byteLength(body([], limits));
	const chunks = chunkRows(state, state.dirty, USAGE_MAX_BODY_BYTES - envelope);
	if (chunks.length === 0 && limits.length > 0)
		chunks.push({ sessions: [], rows: [] });

	const post = async (rows: UsageRow[], lims: UsageLimit[]) => {
		try {
			const res = await fetchImpl(`${cfg.hubUrl}/ingest/usage`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${cfg.ingestToken ?? ""}`,
				},
				body: body(rows, lims),
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
			});
			await res.body?.cancel().catch(() => {});
			return res.status;
		} catch {
			return 0;
		}
	};
	const ok = (status: number) => status >= 200 && status < 300;
	const refused = (status: number) => status === 400 || status === 413;
	const dropLimits = () => {
		limits = [];
		state.limits_dirty = false;
	};
	/** True when every row was taken (or, alone and still refused, dropped); false = try again later. */
	const deliver = async (rows: UsageRow[]): Promise<boolean> => {
		const lims = limits;
		const status = await post(rows, lims);
		if (ok(status)) {
			result.posted++;
			result.rows += rows.length;
			if (lims.length > 0) dropLimits();
			return true;
		}
		if (!refused(status)) {
			result.failed = status;
			return false;
		}
		if (rows.length > 1) {
			const half = Math.ceil(rows.length / 2);
			return (
				(await deliver(rows.slice(0, half))) &&
				(await deliver(rows.slice(half)))
			);
		}
		if (lims.length > 0) {
			// the limits ride along: the rows alone, then the limits alone
			limits = [];
			if (rows.length > 0 && !(await deliver(rows))) {
				limits = lims;
				return false;
			}
			const alone = await post([], lims);
			if (ok(alone)) result.posted++;
			else if (!refused(alone)) {
				limits = lims;
				result.failed = alone;
				return false;
			} else result.failed ??= alone;
			dropLimits();
			return true;
		}
		// one row the hub will never take as it is: drop it (it goes again only when it changes) instead
		// of blocking every later chunk forever
		result.failed ??= status;
		return true;
	};

	for (const chunk of chunks) {
		if (chunk.rows.length > 0 || limits.length > 0) {
			if (!(await deliver(chunk.rows))) return result; // the rest stays marked; next poll
		}
		// sessions with nothing left to say (all their days aged out) are cleared too
		const done = new Set(chunk.sessions);
		state.dirty = state.dirty.filter((s) => !done.has(s));
	}
	return result;
}

export interface UsagePollerOptions {
	cfg: CollectorConfig;
	deps?: ScanDeps;
	fetchImpl?: typeof fetch;
	now?: () => number;
	log?: (line: string) => void;
}

const code = (err: unknown): string =>
	typeof (err as { code?: unknown })?.code === "string"
		? String((err as { code: string }).code).slice(0, 32)
		: "error";

/** One poll: scan, save, send. Resolves to the delay until the next one. Never throws. */
export function createUsagePoll(
	opts: UsagePollerOptions,
): () => Promise<number> {
	const { cfg } = opts;
	const statePath = join(cfg.home, "usage-offsets.json");
	const state = loadUsageState(statePath);
	markAll(state);
	const deps: ScanDeps = opts.deps ?? { git: gitInfo };
	const now = opts.now ?? Date.now;
	const log = opts.log ?? ((l: string) => console.log(l));
	let lastFailure: number | null | undefined;

	return async () => {
		let backlog = false;
		let paused = false;
		try {
			const r = scanUsage({
				claudeRoot: cfg.usage.claudeProjectsDir,
				codexRoot: cfg.codex.sessionsDir,
				state,
				now: now(),
				deps,
			});
			backlog = r.backlog;
			paused = r.paused;
			saveUsageState(statePath, state);
			if (r.backfilled)
				log(
					`[usage] backfill done: ${state.backfill.files} files` +
						(state.backfill.cut > 0
							? `, ${state.backfill.cut} oldest left out`
							: ""),
				);
		} catch (err) {
			log(`[usage] scan failed (${code(err)})`);
		}
		let sendFailed = false;
		try {
			if (state.dirty.length > 0 || state.limits_dirty) {
				const out = await sendUsage(cfg, state, opts.fetchImpl);
				sendFailed = out.failed !== null;
				saveUsageState(statePath, state);
				if (out.failed !== lastFailure) {
					log(
						out.failed === null
							? `[usage] sent ${out.rows} rows`
							: out.failed === -1
								? "[usage] AGENTCITY_MACHINE is not cockpit/forge/spine — not sending"
								: `[usage] hub refused or unreachable (status ${out.failed}); will retry`,
					);
					lastFailure = out.failed;
				}
			}
		} catch (err) {
			log(`[usage] send failed (${code(err)})`);
		}
		// a full file waits for the hub's ack: no point polling fast while the hub refuses or is away
		return backlog && !(paused && sendFailed)
			? USAGE_BACKLOG_MS
			: USAGE_POLL_MS;
	};
}

/** Start the poll loop (first poll after `firstDelayMs`). Returns a stop function. */
export function startUsagePoller(
	opts: UsagePollerOptions & { firstDelayMs?: number },
): () => void {
	const poll = createUsagePoll(opts);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	const run = async () => {
		const next = await poll();
		if (!stopped) timer = setTimeout(run, next);
	};
	timer = setTimeout(run, opts.firstDelayMs ?? 3_000);
	return () => {
		stopped = true;
		if (timer) clearTimeout(timer);
	};
}
