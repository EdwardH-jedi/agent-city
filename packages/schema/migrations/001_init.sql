-- 001_init: base tables. Timestamps are ISO-8601 TEXT (UTC). Applied version tracked via PRAGMA user_version.

CREATE TABLE machines (
  id            TEXT PRIMARY KEY CHECK (id IN ('cockpit', 'forge', 'spine')),
  hostname      TEXT NOT NULL,
  last_seen_at  TEXT
);

CREATE TABLE repos (
  id              INTEGER PRIMARY KEY,           -- GitHub repo id
  full_name       TEXT NOT NULL UNIQUE,          -- owner/name
  district        TEXT NOT NULL DEFAULT 'uncategorized',
  default_branch  TEXT,
  is_private      INTEGER NOT NULL DEFAULT 0,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  pushed_at       TEXT,
  synced_at       TEXT
);

CREATE TABLE repo_paths (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id       INTEGER REFERENCES repos(id) ON DELETE SET NULL,
  machine_id    TEXT NOT NULL REFERENCES machines(id),
  path          TEXT NOT NULL,
  last_seen_at  TEXT,
  UNIQUE (machine_id, path)
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  machine_id  TEXT NOT NULL REFERENCES machines(id),
  kind        TEXT NOT NULL CHECK (kind IN ('claude', 'codex')),
  repo_id     INTEGER REFERENCES repos(id) ON DELETE SET NULL,
  cwd         TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);

CREATE TABLE agents (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE events (
  id          TEXT PRIMARY KEY,                  -- collector-generated, idempotent ingest
  session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  machine_id  TEXT NOT NULL REFERENCES machines(id),
  kind        TEXT NOT NULL,
  ts          TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}'         -- JSON, redacted before insert
);

CREATE INDEX idx_repos_district       ON repos(district);
CREATE INDEX idx_repo_paths_repo      ON repo_paths(repo_id);
CREATE INDEX idx_sessions_machine     ON sessions(machine_id, started_at);
CREATE INDEX idx_sessions_repo        ON sessions(repo_id);
CREATE INDEX idx_agents_session       ON agents(session_id);
CREATE INDEX idx_events_session_ts    ON events(session_id, ts);
CREATE INDEX idx_events_machine_ts    ON events(machine_id, ts);
CREATE INDEX idx_events_kind_ts       ON events(kind, ts);
