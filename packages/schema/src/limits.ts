// Limits shared by collectors and the hub. zod-free (the Claude hook imports this via ./core).

/** Most events in one POST /ingest (F15). Collectors send in chunks of exactly this size. */
export const MAX_INGEST_BATCH = 500;

// Machine heartbeat (POST /ingest/heartbeat). First-implementation values, kept as constants so they
// can be tuned in one place. Liveness is measured on the hub's receive clock only.
/** A heartbeat body is ~200 bytes; anything above this is refused with 413. */
export const HEARTBEAT_MAX_BODY_BYTES = 4 * 1024;
/** Default sender period. A failed send is dropped, never queued. */
export const HEARTBEAT_INTERVAL_S = 30;
export const HEARTBEAT_INTERVAL_MIN_S = 5;
export const HEARTBEAT_INTERVAL_MAX_S = 300;
/** Age below this → online (three missed 30 s beats is the first doubt). */
export const HEARTBEAT_ONLINE_BELOW_MS = 90_000;
/** Age at or above this → offline; in between → stale. */
export const HEARTBEAT_OFFLINE_FROM_MS = 600_000;

// Machine gap history (N12, migration 009). A gap is a completed silence of at least HEARTBEAT_ONLINE_BELOW_MS
// between two accepted beats, on the hub's receive clock.
/** A stored gap is kept this long after it ended. */
export const MACHINE_GAP_RETAIN_MS = 30 * 24 * 3_600_000;
/** At most this many expired gaps are deleted per gap written (the prune never scans the whole table). */
export const MACHINE_GAP_PRUNE_BATCH = 64;
/** GET /api/machines and the `machine` message carry the gaps that ended within this window… */
export const MACHINE_GAPS_RECENT_MS = 24 * 3_600_000;
/** …at most this many per machine (the newest). */
export const MACHINE_GAPS_MAX = 20;

// Office run projection (POST /ingest/runs). First-implementation values, tunable in one place.
/** A snapshot of a few runs with their recent events is tens of KiB; above this → 413. */
export const RUNS_MAX_BODY_BYTES = 256 * 1024;
export const RUNS_MAX_PER_PAYLOAD = 50;
export const RUN_EVENTS_MAX_PER_RUN = 200;
export const RUN_COMPLETED_MAX = 50;
/** The exporter sends every 30 s; three missed sends (90 s) make a run snapshot stale. */
export const RUN_SNAPSHOT_STALE_MS = 90_000;
