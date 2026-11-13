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

-- All-time sums per tool (18 §5.6 U4: usage rows are never deleted and the board shows a cumulative
-- total). Kept by the triggers below inside the writing statement's own transaction, so reading the
-- total costs one row per tool instead of a scan of every usage row (measured ~40 ms at 200k rows).
-- REAL: exact far past any real total (2^53) and cannot overflow like an INTEGER sum.
CREATE TABLE usage_total (
  tool               TEXT PRIMARY KEY,           -- claude | codex
  input_tokens       REAL NOT NULL DEFAULT 0,
  output_tokens      REAL NOT NULL DEFAULT 0,
  cache_read_tokens  REAL NOT NULL DEFAULT 0,
  cache_write_tokens REAL NOT NULL DEFAULT 0,
  messages           REAL NOT NULL DEFAULT 0
);

CREATE TRIGGER usage_total_insert AFTER INSERT ON usage BEGIN
  INSERT INTO usage_total (tool, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    messages)
  VALUES (NEW.tool, NEW.input_tokens, NEW.output_tokens, NEW.cache_read_tokens,
    NEW.cache_write_tokens, NEW.messages)
  ON CONFLICT(tool) DO UPDATE SET
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    messages = messages + excluded.messages;
END;

-- An update may change the counts and (in principle) the tool: take the old row out, put the new one in.
CREATE TRIGGER usage_total_update
AFTER UPDATE OF tool, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, messages
ON usage BEGIN
  UPDATE usage_total SET
    input_tokens = input_tokens - OLD.input_tokens,
    output_tokens = output_tokens - OLD.output_tokens,
    cache_read_tokens = cache_read_tokens - OLD.cache_read_tokens,
    cache_write_tokens = cache_write_tokens - OLD.cache_write_tokens,
    messages = messages - OLD.messages
  WHERE tool = OLD.tool;
  INSERT INTO usage_total (tool, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    messages)
  VALUES (NEW.tool, NEW.input_tokens, NEW.output_tokens, NEW.cache_read_tokens,
    NEW.cache_write_tokens, NEW.messages)
  ON CONFLICT(tool) DO UPDATE SET
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    messages = messages + excluded.messages;
END;

CREATE TRIGGER usage_total_delete AFTER DELETE ON usage BEGIN
  UPDATE usage_total SET
    input_tokens = input_tokens - OLD.input_tokens,
    output_tokens = output_tokens - OLD.output_tokens,
    cache_read_tokens = cache_read_tokens - OLD.cache_read_tokens,
    cache_write_tokens = cache_write_tokens - OLD.cache_write_tokens,
    messages = messages - OLD.messages
  WHERE tool = OLD.tool;
END;
