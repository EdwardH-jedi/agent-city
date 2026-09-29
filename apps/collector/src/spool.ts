// Local spool (~/.agentcity/spool.jsonl) so events survive hub downtime, plus the HTTP transport.
//
// Durability (F04): every event is appended to the spool BEFORE any network I/O; the POST only runs
// in whatever time is left, and a delivered file is removed afterwards. A hook killed at any point
// leaves its event on disk.
//
// Concurrency: parallel hooks share one spool. Nothing rewrites spool.jsonl in place:
//   append → one O_APPEND write (small lines are atomic)
//   flush  → atomically rename spool.jsonl → spool.<µs>.<pid>.<rand>.flushing (acts as a lock),
//            then send every *.flushing oldest-first in chunks; a file is deleted once fully sent.
//            On the first failure the unsent remainder stays in its file → order is preserved and
//            a flusher killed mid-way leaves a file the next flusher picks up.
// Two flushers racing on one file can double-send; the hub dedupes by event id.
//
// Bounds (F05): total spool bytes ≤ SPOOL_MAX_MB, events older than SPOOL_MAX_AGE_DAYS are dropped,
// spool.rejected.jsonl ≤ 5 MB. Oldest data goes first; drops are counted in spool-stats.json and
// reported to the hub (x-agentcity-spool-dropped → /healthz).
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { IngestEvent } from "@agent-city/schema/core";
import type { CollectorConfig } from "./config.ts";

export const CHUNK = 500;
/** A POST with less time than this left isn't worth starting. */
const MIN_POST_MS = 30;

/** µs since epoch — orders .flushing files across processes even within the same millisecond. */
const epochMicros = () =>
	Math.floor((performance.timeOrigin + performance.now()) * 1000);

/** ok: stored · rejected: hub refused the payload (4xx) — retrying won't help · failed: retry later */
export type PostResult = "ok" | "rejected" | "failed";

export interface PostOptions {
	/** Absolute epoch-ms deadline; the request timeout never runs past it. */
	deadline?: number;
	/** Cumulative dropped-event count, reported to the hub. */
	dropped?: number;
}

export interface Transport {
	post(events: readonly IngestEvent[], opts?: PostOptions): Promise<PostResult>;
}

export function createTransport(
	cfg: Pick<CollectorConfig, "hubUrl" | "ingestToken"> &
		Partial<Pick<CollectorConfig, "machine">>,
	timeoutMs: number,
	fetchImpl: typeof fetch = fetch,
): Transport {
	return {
		async post(events, opts = {}) {
			if (!cfg.ingestToken) return "failed"; // keep spooling until configured
			const left =
				opts.deadline === undefined
					? timeoutMs
					: Math.min(timeoutMs, opts.deadline - Date.now());
			if (left < MIN_POST_MS) return "failed";
			const headers: Record<string, string> = {
				authorization: `Bearer ${cfg.ingestToken}`,
				"content-type": "application/json",
			};
			if (cfg.machine) headers["x-agentcity-machine"] = cfg.machine;
			if (opts.dropped !== undefined)
				headers["x-agentcity-spool-dropped"] = String(opts.dropped);
			try {
				const res = await fetchImpl(`${cfg.hubUrl}/ingest`, {
					method: "POST",
					headers,
					body: JSON.stringify(events),
					signal: AbortSignal.timeout(left),
				});
				if (res.ok) return "ok";
				// bad payload / too large: parking it keeps the queue moving
				if ([400, 413, 422].includes(res.status)) return "rejected";
				return "failed"; // 401/503/5xx: config or hub problem → retry later
			} catch {
				return "failed"; // refused / timeout
			}
		},
	};
}

export interface SpoolLimits {
	maxBytes: number;
	maxAgeMs: number;
	rejectedMaxBytes: number;
}

export const DEFAULT_LIMITS: SpoolLimits = {
	maxBytes: 20 * 1024 * 1024,
	maxAgeMs: 7 * 86_400_000,
	rejectedMaxBytes: 5 * 1024 * 1024,
};

export interface SpoolStats {
	dropped_overflow: number;
	dropped_age: number;
	rejected_overflow: number;
}

export interface FlushResult {
	sent: number;
	rejected: number;
	/** Something is still queued (failure or deadline). */
	remaining: boolean;
}

const fileSize = (p: string) => {
	try {
		return statSync(p).size;
	} catch {
		return 0;
	}
};
const countLines = (p: string) => {
	try {
		return readFileSync(p, "utf8").split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
};

export class Spool {
	readonly file: string;
	readonly rejectedFile: string;
	readonly statsFile: string;
	readonly limits: SpoolLimits;

	constructor(
		readonly dir: string,
		limits: Partial<SpoolLimits> = {},
	) {
		this.file = join(dir, "spool.jsonl");
		this.rejectedFile = join(dir, "spool.rejected.jsonl");
		this.statsFile = join(dir, "spool-stats.json");
		this.limits = { ...DEFAULT_LIMITS, ...limits };
	}

	/** Durable append. Throws when the spool dir isn't writable (caller decides the fallback). */
	append(events: readonly IngestEvent[]): void {
		if (events.length === 0) return;
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		appendFileSync(
			this.file,
			events.map((e) => `${JSON.stringify(e)}\n`).join(""),
			{ mode: 0o600 },
		);
		this.enforceLimits();
	}

	reject(lines: readonly string[]): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		appendFileSync(this.rejectedFile, `${lines.join("\n")}\n`, {
			mode: 0o600,
		});
		if (fileSize(this.rejectedFile) > this.limits.rejectedMaxBytes) {
			const kept = keepNewest(this.rejectedFile, this.limits.rejectedMaxBytes);
			this.bump({ rejected_overflow: kept.dropped });
		}
	}

	stats(): SpoolStats {
		try {
			const s = JSON.parse(readFileSync(this.statsFile, "utf8"));
			return {
				dropped_overflow: Number(s.dropped_overflow) || 0,
				dropped_age: Number(s.dropped_age) || 0,
				rejected_overflow: Number(s.rejected_overflow) || 0,
			};
		} catch {
			return { dropped_overflow: 0, dropped_age: 0, rejected_overflow: 0 };
		}
	}

	/** Total events this spool has discarded (overflow + age + rejected overflow). */
	droppedTotal(): number {
		const s = this.stats();
		return s.dropped_overflow + s.dropped_age + s.rejected_overflow;
	}

	/** Best-effort counter update (read-modify-write; concurrent hooks may undercount slightly). */
	private bump(delta: Partial<SpoolStats>): void {
		if (!Object.values(delta).some((n) => n)) return;
		const s = this.stats();
		for (const [k, v] of Object.entries(delta))
			s[k as keyof SpoolStats] += v ?? 0;
		try {
			const tmp = `${this.statsFile}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
			renameSync(tmp, this.statsFile);
		} catch {
			// counters are informational
		}
	}

	private flushingFiles(): string[] {
		let names: string[];
		try {
			names = readdirSync(this.dir);
		} catch {
			return [];
		}
		return names
			.filter((n) => /^spool\.\d+\..+\.flushing$/.test(n))
			.sort((a, b) => {
				const ta = Number(a.split(".")[1]);
				const tb = Number(b.split(".")[1]);
				return ta - tb || a.localeCompare(b);
			})
			.map((n) => join(this.dir, n));
	}

	private claim(): void {
		try {
			renameSync(
				this.file,
				join(
					this.dir,
					`spool.${epochMicros()}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.flushing`,
				),
			);
		} catch {
			// nothing new to claim (ENOENT)
		}
	}

	/**
	 * Size / age caps. Cheap when within limits (a few stats). Over the size cap, spool.jsonl is
	 * claimed and whole oldest .flushing files are dropped — spool.jsonl itself is never rewritten.
	 */
	enforceLimits(now = Date.now()): void {
		const files = this.flushingFiles();
		let total = fileSize(this.file);
		for (const f of files) {
			let st: ReturnType<typeof statSync> | undefined;
			try {
				st = statSync(f);
			} catch {
				continue;
			}
			if (now - st.mtimeMs > this.limits.maxAgeMs) {
				const n = countLines(f);
				try {
					unlinkSync(f);
					this.bump({ dropped_age: n });
				} catch {}
				continue;
			}
			total += st.size;
		}
		if (total <= this.limits.maxBytes) return;

		this.claim();
		const all = this.flushingFiles();
		let dropped = 0;
		while (total > this.limits.maxBytes && all.length > 1) {
			const oldest = all.shift() as string;
			const size = fileSize(oldest);
			const n = countLines(oldest);
			try {
				unlinkSync(oldest);
				dropped += n;
				total -= size;
			} catch {}
		}
		if (total > this.limits.maxBytes && all[0]) {
			dropped += keepNewest(all[0], this.limits.maxBytes).dropped;
		}
		this.bump({ dropped_overflow: dropped });
	}

	pending(): boolean {
		return existsSync(this.file) || this.flushingFiles().length > 0;
	}

	/** Send queued events in order. Stops at the first failure or once `deadline` (epoch ms) passes. */
	async flush(
		transport: Transport,
		deadline = Number.POSITIVE_INFINITY,
	): Promise<FlushResult> {
		const result: FlushResult = { sent: 0, rejected: 0, remaining: false };
		this.claim();
		const cutoff = Date.now() - this.limits.maxAgeMs;
		const dropped = this.droppedTotal();

		for (const path of this.flushingFiles()) {
			let lines: string[];
			try {
				lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
			} catch {
				continue; // another flusher finished it
			}
			let i = 0;
			let aged = 0;
			while (i < lines.length) {
				if (Date.now() > deadline) break;
				const chunkLines = lines.slice(i, i + CHUNK);
				const events: IngestEvent[] = [];
				for (const l of chunkLines) {
					try {
						const e = JSON.parse(l) as IngestEvent;
						if (Date.parse(e.ts) < cutoff) aged++;
						else events.push(e);
					} catch {
						// torn/corrupt line → drop
					}
				}
				const r = events.length
					? await transport.post(events, { deadline, dropped })
					: "ok";
				if (r === "failed") break;
				if (r === "rejected") {
					this.reject(chunkLines);
					result.rejected += events.length;
				} else {
					result.sent += events.length;
				}
				i += chunkLines.length;
			}
			this.bump({ dropped_age: aged });
			try {
				if (i >= lines.length) {
					unlinkSync(path);
				} else {
					// keep only what wasn't delivered (tmp + rename = atomic)
					const tmp = `${path}.tmp`;
					writeFileSync(tmp, `${lines.slice(i).join("\n")}\n`, { mode: 0o600 });
					renameSync(tmp, path);
					result.remaining = true;
					return result;
				}
			} catch {
				// raced with another flusher — it owns the file now
			}
		}
		result.remaining = this.pending();
		return result;
	}
}

/** Rewrite `path` keeping only its newest lines that fit in `maxBytes`. */
function keepNewest(path: string, maxBytes: number): { dropped: number } {
	try {
		const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
		let size = 0;
		let start = lines.length;
		while (start > 0) {
			const len = Buffer.byteLength(lines[start - 1] ?? "") + 1;
			if (size + len > maxBytes) break;
			size += len;
			start--;
		}
		const tmp = `${path}.${process.pid}.trim`;
		writeFileSync(
			tmp,
			lines
				.slice(start)
				.map((l) => `${l}\n`)
				.join(""),
			{
				mode: 0o600,
			},
		);
		renameSync(tmp, path);
		return { dropped: start };
	} catch {
		return { dropped: 0 };
	}
}

export type DeliverOutcome = "sent" | "spooled" | "failed";

/**
 * Deliver new events, spool-first (F04): append durably, then flush within `deadline`.
 *   sent    — everything queued reached the hub
 *   spooled — durable on disk, will be retried
 *   failed  — neither durable nor delivered (spool unwritable AND POST failed)
 * If the spool can't be written, one bounded direct POST is the fallback.
 */
export async function deliver(
	events: readonly IngestEvent[],
	spool: Spool,
	transport: Transport,
	deadline = Number.POSITIVE_INFINITY,
): Promise<DeliverOutcome> {
	if (events.length === 0) return "sent";
	try {
		spool.append(events);
	} catch {
		for (let i = 0; i < events.length; i += CHUNK) {
			const r = await transport.post(events.slice(i, i + CHUNK), { deadline });
			if (r === "failed") return "failed";
		}
		return "sent";
	}
	const r = await spool.flush(transport, deadline);
	return r.remaining ? "spooled" : "sent";
}
