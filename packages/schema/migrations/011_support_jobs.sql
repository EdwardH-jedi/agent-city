-- 011: durable support jobs (docs/support-lane.md "Persistence and API"). Read-only informational work: no column
-- names a command, a writable path, a credential, a managed task or an approval request, and nothing here links to
-- the workspace / managed tables. A hub-level migration: the workspace schema helper (WORKSPACE_SCHEMA_VERSION 10)
-- is unaffected.
--
-- Mirrors apps/hub/src/support-jobs/job.ts `SupportJob`; the row is re-validated with that schema on every read
-- (fail closed). The triggers keep the database honest on their own: rows are never deleted, a terminal job never
-- changes, every update bumps `rev` by exactly 1, the request columns are immutable, and status moves only along
--   QUEUED → RUNNING | CANCELLED,  RUNNING → COMPLETED | FAILED | CANCELLED.

CREATE TABLE support_jobs (
  id               TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  created_seq      INTEGER NOT NULL UNIQUE CHECK (created_seq >= 0),
  created_by       TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
  idempotency_key  TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash     TEXT NOT NULL CHECK (length(request_hash) = 64),
  repo_id          TEXT NOT NULL CHECK (length(repo_id) BETWEEN 1 AND 300),
  kind             TEXT NOT NULL CHECK (kind IN ('REPO_STATUS', 'HANDOFF', 'LOG_TRIAGE', 'EVIDENCE_SUMMARY',
                                                 'REVIEW_TO_TODOS', 'PR_DRAFT', 'CONTEXT_PACKAGE')),
  capability       TEXT NOT NULL CHECK (capability IN ('fast', 'standard')),
  inputs           TEXT NOT NULL CHECK (json_valid(inputs) AND json_type(inputs) = 'array'
                                        AND json_array_length(inputs) <= 32),
  brief            TEXT CHECK (brief IS NULL OR length(brief) BETWEEN 1 AND 2000),
  priority         INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 100),
  status           TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  disabled         INTEGER NOT NULL CHECK (disabled IN (0, 1)),
  cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
  profile_id       TEXT CHECK (profile_id IS NULL OR length(profile_id) BETWEEN 1 AND 128),
  result           TEXT CHECK (result IS NULL OR (json_valid(result) AND json_type(result) = 'object')),
  failure          TEXT CHECK (failure IS NULL OR (json_valid(failure) AND json_type(failure) = 'object')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  rev              INTEGER NOT NULL CHECK (rev >= 1),
  UNIQUE (created_by, idempotency_key),
  CHECK ((status = 'COMPLETED') = (result IS NOT NULL)),
  CHECK ((status = 'FAILED') = (failure IS NOT NULL)),
  CHECK (cancel_requested = 0 OR status IN ('RUNNING', 'CANCELLED'))
);

CREATE INDEX idx_support_jobs_repo ON support_jobs(repo_id, created_seq);
CREATE INDEX idx_support_jobs_status ON support_jobs(status, created_seq);

CREATE TRIGGER support_jobs_insert_shape BEFORE INSERT ON support_jobs
BEGIN
  SELECT RAISE(ABORT, 'support_jobs: a new job starts QUEUED at rev 1 with no cancel, profile, result or failure')
  WHERE NEW.status <> 'QUEUED' OR NEW.rev <> 1 OR NEW.cancel_requested <> 0 OR NEW.profile_id IS NOT NULL
     OR NEW.result IS NOT NULL OR NEW.failure IS NOT NULL;
END;

CREATE TRIGGER support_jobs_update_rules BEFORE UPDATE ON support_jobs
BEGIN
  SELECT RAISE(ABORT, 'support_jobs: a terminal job never changes')
  WHERE OLD.status IN ('COMPLETED', 'FAILED', 'CANCELLED');
  SELECT RAISE(ABORT, 'support_jobs: rev must grow by exactly 1 on every update')
  WHERE NEW.rev IS NOT OLD.rev + 1;
  SELECT RAISE(ABORT, 'support_jobs: request columns are immutable')
  WHERE NEW.id IS NOT OLD.id OR NEW.created_seq IS NOT OLD.created_seq
     OR NEW.created_by IS NOT OLD.created_by OR NEW.idempotency_key IS NOT OLD.idempotency_key
     OR NEW.request_hash IS NOT OLD.request_hash OR NEW.repo_id IS NOT OLD.repo_id
     OR NEW.kind IS NOT OLD.kind OR NEW.capability IS NOT OLD.capability
     OR NEW.inputs IS NOT OLD.inputs OR NEW.brief IS NOT OLD.brief
     OR NEW.priority IS NOT OLD.priority OR NEW.disabled IS NOT OLD.disabled
     OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'support_jobs: illegal status transition')
  WHERE NEW.status IS NOT OLD.status
    AND NOT ((OLD.status = 'QUEUED' AND NEW.status IN ('RUNNING', 'CANCELLED'))
          OR (OLD.status = 'RUNNING' AND NEW.status IN ('COMPLETED', 'FAILED', 'CANCELLED')));
  SELECT RAISE(ABORT, 'support_jobs: a profile is assigned only while QUEUED and never changed')
  WHERE NEW.profile_id IS NOT OLD.profile_id AND (OLD.status <> 'QUEUED' OR OLD.profile_id IS NOT NULL);
  SELECT RAISE(ABORT, 'support_jobs: cancellation is never withdrawn')
  WHERE OLD.cancel_requested = 1 AND NEW.cancel_requested = 0;
END;

CREATE TRIGGER support_jobs_no_delete BEFORE DELETE ON support_jobs
BEGIN
  SELECT RAISE(ABORT, 'support_jobs: rows are history and are never deleted');
END;
