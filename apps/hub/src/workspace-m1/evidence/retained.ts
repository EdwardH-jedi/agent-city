// Retained verified bytes: the buffers one seal (or Gate-2 revalidation) actually hashed, kept in
// hub memory under the envelope hash they produced, so serving an artifact of a sealed result uses
// exactly those bytes instead of reopening a path an attacker could have replaced since.
//
// What is retained: per envelope hash, a private COPY of every `verified`/`truncated` artifact
// buffer with its sha256 and status (withheld/corrupt/stale/unknown content is never retained).
// For how long: until evicted — LRU, at most `max_entries` envelopes and `max_bytes` total, each at
// most `ttl_ms` old — and never across a hub restart (memory only). After eviction or restart the
// reader falls back to a fresh verified read compared against the bound envelope item.
// Integrity in memory: every take() re-hashes the retained copy and hands out a fresh copy, so
// neither an in-process mutation of a returned buffer nor of the retained one can be served.
// Out of scope: an attacker who can write hub process memory.
import { createHash } from "node:crypto";
import type { EvidenceStatus } from "@agent-city/schema/workspace-m1";

export interface RetainedItem {
	artifact_id: string;
	sha256: string;
	status: EvidenceStatus;
	buffer: Buffer;
}

interface Entry {
	envelope_hash: string;
	managed_task_id: string;
	run_id: string;
	items: Map<string, RetainedItem>;
	bytes: number;
	retained_at: number;
}

export interface RetainedLimits {
	max_entries: number;
	max_bytes: number;
	ttl_ms: number;
}

export const DEFAULT_RETAINED_LIMITS: Readonly<RetainedLimits> = {
	max_entries: 16,
	max_bytes: 64 * 1024 * 1024,
	ttl_ms: 12 * 60 * 60 * 1000,
};

const RETAINABLE: ReadonlySet<EvidenceStatus> = new Set([
	"verified",
	"truncated",
]);

export class RetainedEvidenceStore {
	private readonly entries = new Map<string, Entry>();
	private bytes = 0;
	private readonly limits: RetainedLimits;
	private readonly now: () => number;

	constructor(o: Partial<RetainedLimits> & { now?: () => number } = {}) {
		this.limits = { ...DEFAULT_RETAINED_LIMITS, ...o };
		this.now = o.now ?? Date.now;
	}

	/** Retain copies of the verified buffers of one sealed envelope (replaces an earlier entry). */
	put(e: {
		envelope_hash: string;
		managed_task_id: string;
		run_id: string;
		items: readonly RetainedItem[];
	}): void {
		this.drop(e.envelope_hash);
		const items = new Map<string, RetainedItem>();
		let bytes = 0;
		for (const it of e.items) {
			if (!RETAINABLE.has(it.status)) continue;
			items.set(it.artifact_id, {
				artifact_id: it.artifact_id,
				sha256: it.sha256,
				status: it.status,
				buffer: Buffer.from(it.buffer),
			});
			bytes += it.buffer.length;
		}
		if (bytes > this.limits.max_bytes) return; // too large to retain: fresh reads instead
		this.entries.set(e.envelope_hash, {
			envelope_hash: e.envelope_hash,
			managed_task_id: e.managed_task_id,
			run_id: e.run_id,
			items,
			bytes,
			retained_at: this.now(),
		});
		this.bytes += bytes;
		this.evict();
	}

	/**
	 * A fresh copy of one retained item, verified against its sha256 — or null (not retained,
	 * expired, other task/run, or the retained copy no longer hashes to its sha256).
	 */
	take(
		envelope_hash: string,
		scope: { managed_task_id: string; run_id: string },
		artifact_id: string,
	): { buffer: Buffer; sha256: string; status: EvidenceStatus } | null {
		const e = this.entries.get(envelope_hash);
		if (!e) return null;
		if (this.now() - e.retained_at > this.limits.ttl_ms) {
			this.drop(envelope_hash);
			return null;
		}
		if (
			e.managed_task_id !== scope.managed_task_id ||
			e.run_id !== scope.run_id
		)
			return null;
		const it = e.items.get(artifact_id);
		if (!it) return null;
		if (createHash("sha256").update(it.buffer).digest("hex") !== it.sha256) {
			this.drop(envelope_hash);
			return null;
		}
		// LRU touch
		this.entries.delete(envelope_hash);
		this.entries.set(envelope_hash, e);
		return {
			buffer: Buffer.from(it.buffer),
			sha256: it.sha256,
			status: it.status,
		};
	}

	has(envelope_hash: string): boolean {
		return this.entries.has(envelope_hash);
	}

	get size(): { entries: number; bytes: number } {
		return { entries: this.entries.size, bytes: this.bytes };
	}

	clear(): void {
		this.entries.clear();
		this.bytes = 0;
	}

	private drop(hash: string) {
		const e = this.entries.get(hash);
		if (!e) return;
		this.entries.delete(hash);
		this.bytes -= e.bytes;
	}

	private evict() {
		const now = this.now();
		for (const [h, e] of this.entries)
			if (now - e.retained_at > this.limits.ttl_ms) this.drop(h);
		while (
			this.entries.size > this.limits.max_entries ||
			this.bytes > this.limits.max_bytes
		) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.drop(oldest);
		}
	}
}
