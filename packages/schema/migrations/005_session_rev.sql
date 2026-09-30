-- 005_session_rev: per-session version counter (re-audit N05). Incremented on every write to a
-- sessions row (ingest upsert, stale sweep, repo remap). Clients merge snapshots and live updates
-- by rev — a copy with a higher rev wins; timestamps are no longer compared.

ALTER TABLE sessions ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
