-- 002_event_model: replace the Step 0 placeholder tables with the Phase 0 event model.
--
-- DROP + CREATE instead of ALTER because SQLite cannot change a PK type (repos.id INTEGER → TEXT
-- owner/name), drop a CHECK (machines.id), or rename+re-check a column (sessions.kind → provider).
-- Safe: in Step 0 every write path was a stub (501 / throw), so 001's tables can only be empty.
--
-- repo_id columns deliberately have NO foreign key: collectors compute the slug locally and it may
-- reach the hub before GitHub sync has created the repos row.

DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS repo_paths;
DROP TABLE IF EXISTS repos;
DROP TABLE IF EXISTS machines;

CREATE TABLE machines (
  id            TEXT PRIMARY KEY,
  hostname      TEXT,
  role          TEXT CHECK (role IN ('cockpit', 'forge', 'spine')),
  last_seen_at  TEXT
);

CREATE TABLE repos (
  id             TEXT PRIMARY KEY,                -- owner/name
  is_private     INTEGER NOT NULL DEFAULT 0,
  is_archived    INTEGER NOT NULL DEFAULT 0,
  is_fork        INTEGER NOT NULL DEFAULT 0,
  language       TEXT,
  pushed_at      TEXT,
  commits_30d    INTEGER,
  open_prs       INTEGER,
  open_issues    INTEGER,
  ci_status      TEXT NOT NULL DEFAULT 'none'
                 CHECK (ci_status IN ('success', 'failure', 'running', 'none')),
  ci_updated_at  TEXT,
  district       TEXT NOT NULL DEFAULT 'uncategorized',
  is_local_only  INTEGER NOT NULL DEFAULT 0,
  synced_at      TEXT
);

CREATE TABLE repo_paths (
  machine_id   TEXT NOT NULL REFERENCES machines(id),
  path         TEXT NOT NULL,
  repo_id      TEXT NOT NULL,
  is_worktree  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (machine_id, path)
);

CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'ollama')),
  machine_id     TEXT NOT NULL REFERENCES machines(id),
  repo_id        TEXT,
  cwd            TEXT,
  branch         TEXT,
  model          TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'waiting', 'idle', 'stale', 'ended')),
  started_at     TEXT NOT NULL,
  last_event_at  TEXT NOT NULL,
  ended_at       TEXT
);

CREATE TABLE agents (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_agent_id  TEXT REFERENCES agents(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('main', 'subagent')),
  label            TEXT
);

CREATE TABLE events (
  id                TEXT PRIMARY KEY,             -- collector-generated, idempotent ingest
  ts                TEXT NOT NULL,
  machine_id        TEXT NOT NULL,
  session_id        TEXT,
  agent_id          TEXT,
  provider          TEXT NOT NULL,
  type              TEXT NOT NULL,
  tool              TEXT,
  summary           TEXT,
  repo_id           TEXT,
  payload_redacted  TEXT NOT NULL DEFAULT '{}'    -- JSON, redacted by the collector
);

CREATE INDEX idx_repos_district          ON repos(district);
CREATE INDEX idx_repos_pushed            ON repos(pushed_at);
CREATE INDEX idx_repo_paths_repo         ON repo_paths(repo_id);
CREATE INDEX idx_sessions_status_last    ON sessions(status, last_event_at);
CREATE INDEX idx_sessions_repo           ON sessions(repo_id);
CREATE INDEX idx_agents_session          ON agents(session_id);
CREATE INDEX idx_events_ts               ON events(ts);
CREATE INDEX idx_events_session_ts       ON events(session_id, ts);
CREATE INDEX idx_events_repo_ts          ON events(repo_id, ts);
