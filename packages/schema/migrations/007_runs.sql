-- 007_runs: read-only projection of Agent Office runs, pushed by the cockpit (POST /ingest/runs).
-- City stores what it was told ("reported"), never decides or acts: no approve/launch/retry exists here.
-- received_at is the HUB's receive time (ISO-8601 UTC); snapshot staleness is measured on it only.

CREATE TABLE runs (
  machine_id          TEXT NOT NULL REFERENCES machines(id),
  run_id              TEXT NOT NULL,
  project             TEXT,
  workflow_id         TEXT NOT NULL,
  phase               TEXT NOT NULL,
  status              TEXT NOT NULL,
  reason              TEXT,
  alert               TEXT,
  last_progress_at    TEXT,
  idle_seconds        INTEGER,
  completed           TEXT NOT NULL DEFAULT '[]',   -- JSON array of task ids
  tokens_today        INTEGER,
  usage_unknown       INTEGER NOT NULL DEFAULT 0,
  evidence_verified   INTEGER NOT NULL DEFAULT 1,
  last_event_sequence INTEGER,
  ledger_revision     INTEGER NOT NULL,
  observed_at         TEXT NOT NULL,                -- the sender's clock, display only
  received_at         TEXT NOT NULL,
  PRIMARY KEY (machine_id, run_id)
);

CREATE TABLE run_events (
  machine_id    TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  sequence      INTEGER NOT NULL,
  transition    TEXT NOT NULL,
  occurred_at   TEXT,
  task_id       TEXT,
  attempt       INTEGER,
  outcome       TEXT,
  reason        TEXT,
  review_verdict TEXT,
  commit_sha    TEXT,
  base_commit   TEXT,
  diff_digest   TEXT,
  tree_digest   TEXT,
  test_run_key  TEXT,
  model         TEXT,
  from_model    TEXT,
  to_model      TEXT,
  PRIMARY KEY (machine_id, run_id, sequence),
  FOREIGN KEY (machine_id, run_id) REFERENCES runs(machine_id, run_id) ON DELETE CASCADE
);

CREATE INDEX runs_received ON runs (received_at DESC);
