-- 008_usage: token usage per (session, Australia/Sydney day, model), pushed by the collectors
-- (POST /ingest/usage, 18 §5.1). Numbers and identifiers only: no text, command or path column exists.
-- Values are the session's cumulative counts; an upsert keeps the larger value per column, so a
-- repeated report changes nothing. No foreign key to sessions: usage may arrive for a session the hub
-- never saw an event for. updated_at is the HUB's receive time of the last report that grew the row.

CREATE TABLE usage (
  session_id         TEXT NOT NULL,
  day                TEXT NOT NULL,              -- YYYY-MM-DD, Australia/Sydney
  model              TEXT NOT NULL,
  tool               TEXT NOT NULL,              -- claude | codex
  project            TEXT,                       -- repo id (repo-slug.ts rule), null outside a repo
  machine_id         TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0, -- not served from the prompt cache
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  messages           INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (session_id, day, model)
);
CREATE INDEX usage_day ON usage(day);

-- Plan limits exactly as a tool's own log stated them (today: Codex rate_limits). Never computed.
-- The newest observation wins (the percentage falls when a window resets, so it is not a max).
CREATE TABLE usage_limits (
  machine_id     TEXT NOT NULL,
  tool           TEXT NOT NULL,
  limit_id       TEXT NOT NULL,
  window_minutes INTEGER NOT NULL,
  used_percent   REAL NOT NULL,
  resets_at      TEXT,
  plan_type      TEXT,
  observed_at    TEXT NOT NULL,                  -- the log record's time
  received_at    TEXT NOT NULL,
  PRIMARY KEY (machine_id, tool, limit_id, window_minutes)
);
