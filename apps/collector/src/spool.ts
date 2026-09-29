// Local spool (~/.agentcity/spool.jsonl) so events survive hub downtime, plus the HTTP transport.
//
// Concurrency: parallel hooks share one spool. Nothing is rewritten in place by appenders:
//   append → one O_APPEND write (small lines are atomic)
//   flush  → atomically rename spool.jsonl → spool.<ts>.<pid>.<rand>.flushing (acts as a lock),
//            then send every *.flushing oldest-first in chunks; a file is deleted once fully sent.
//            On the first failure the unsent remainder stays in its file → order is preserved and
//            a flusher killed mid-way (hook watchdog) leaves a file the next flusher picks up.
// Two flushers racing on one file can double-send; the hub dedupes by event id.
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { IngestEvent } from "@agent-city/schema/core";
import type { CollectorConfig } from "./config.ts";

export const CHUNK = 500;

/** µs since epoch — orders .flushing files across processes even within the same millisecond. */
const epochMicros = () =>
	Math.floor((performance.timeOrigin + performance.now()) * 1000);

/** ok: stored · rejected: hub refused the payload (4xx) — retrying won't help · failed: retry later */
export type PostResult = "ok" | "rejected" | "failed";

export interface Transport {
	post(events: readonly IngestEvent[]): Promise<PostResult>;
}

export function createTransport(
	cfg: Pick<CollectorConfig, "hubUrl" | "ingestToken">,
	timeoutMs: number,
	fetchImpl: typeof fetch = fetch,
): Transport {
	return {
		async post(events) {
			if (!cfg.ingestToken) return "failed"; // keep spooling until configured
			try {
				const res = await fetchImpl(`${cfg.hubUrl}/ingest`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${cfg.ingestToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(events),
					signal: AbortSignal.timeout(timeoutMs),
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

export interface FlushResult {
	sent: number;
	rejected: number;
	/** Something is still queued (failure or deadline). */
	remaining: boolean;
}

export class Spool {
	readonly file: string;
	readonly rejectedFile: string;

	constructor(readonly dir: string) {
		this.file = join(dir, "spool.jsonl");
		this.rejectedFile = join(dir, "spool.rejected.jsonl");
	}

	append(events: readonly IngestEvent[]): void {
		if (events.length === 0) return;
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		appendFileSync(
			this.file,
			events.map((e) => `${JSON.stringify(e)}\n`).join(""),
			{ mode: 0o600 },
		);
	}

	reject(lines: readonly string[]): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		appendFileSync(this.rejectedFile, `${lines.join("\n")}\n`, { mode: 0o600 });
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

	pending(): boolean {
		return existsSync(this.file) || this.flushingFiles().length > 0;
	}

	/** Send queued events in order. Stops at the first failure or once `deadline` (epoch ms) passes. */
	async flush(
		transport: Transport,
		deadline = Number.POSITIVE_INFINITY,
	): Promise<FlushResult> {
		const result: FlushResult = { sent: 0, rejected: 0, remaining: false };
		try {
			renameSync(
				this.file,
				join(
					this.dir,
					`spool.${epochMicros()}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.flushing`,
				),
			);
		} catch {
			// nothing new to claim (ENOENT) — still drain older .flushing files
		}

		for (const path of this.flushingFiles()) {
			let lines: string[];
			try {
				lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
			} catch {
				continue; // another flusher finished it
			}
			let i = 0;
			while (i < lines.length) {
				if (Date.now() > deadline) break;
				const chunkLines = lines.slice(i, i + CHUNK);
				const events: IngestEvent[] = [];
				for (const l of chunkLines) {
					try {
						events.push(JSON.parse(l) as IngestEvent);
					} catch {
						// torn/corrupt line → drop
					}
				}
				const r = events.length ? await transport.post(events) : "ok";
				if (r === "failed") break;
				if (r === "rejected") {
					this.reject(chunkLines);
					result.rejected += events.length;
				} else {
					result.sent += events.length;
				}
				i += chunkLines.length;
			}
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

/**
 * Deliver new events: straight POST when the spool is empty; otherwise queue behind the spooled
 * ones and flush (keeps order). Anything not delivered ends up in the spool.
 */
export async function deliver(
	events: readonly IngestEvent[],
	spool: Spool,
	transport: Transport,
	deadline = Number.POSITIVE_INFINITY,
): Promise<"sent" | "spooled"> {
	if (events.length === 0) return "sent";
	if (spool.pending()) {
		spool.append(events);
		const r = await spool.flush(transport, deadline);
		return r.remaining ? "spooled" : "sent";
	}
	for (let i = 0; i < events.length; i += CHUNK) {
		const chunk = events.slice(i, i + CHUNK);
		const r = await transport.post(chunk);
		if (r === "failed") {
			spool.append(events.slice(i));
			return "spooled";
		}
		if (r === "rejected") spool.reject(chunk.map((e) => JSON.stringify(e)));
	}
	return "sent";
}
