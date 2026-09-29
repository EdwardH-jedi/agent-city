import type { Event } from "@agent-city/schema";

// Local append-only spool (./spool, gitignored) so events survive hub downtime.
// TODO(phase-0): JSONL files per day, atomic append, flush → POST $HUB_URL/ingest with INGEST_TOKEN, delete on 2xx.

export async function append(_event: Event): Promise<void> {
	throw new Error("spool.append: not implemented");
}

export async function flush(): Promise<number> {
	throw new Error("spool.flush: not implemented");
}
