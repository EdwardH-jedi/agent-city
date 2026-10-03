-- 009_accepted_evidence_validity: durable accepted evidence + current acceptance validity (contract
-- delta v1.2, docs/workspace-m1/CONTRACT_V1_2.md §B/§C; DTOs: rows.ts). Additive only: 008 is never
-- edited and none of its triggers is relaxed — closed requests, decisions and accepted tasks stay
-- immutable. ADD COLUMN touches no row (no 008 UPDATE trigger fires) and existing rows read NULL.
--
--   managed_evidence_bundles      one row per published bundle file `<artifacts_root>/_sealed/<digest>.bundle`
--                                 (content address = sha256 of the whole file); append-only.
--   managed_approval_requests.evidence_bundle_digest
--                                 set at insert for a result request whose bundle was published
--                                 before the row was inserted; immutable afterwards.
--   managed_decisions.evidence_bundle_digest
--                                 a Gate-2 accept carries exactly its request's digest; every other
--                                 decision carries none.
--   managed_acceptance_validity   the CURRENT validity of an accepted result, separate from the
--                                 historical decision (which never changes). `invalid` and
--                                 `unverifiable` are sticky; rows are never deleted.
--
-- Backfill (honest, no invented proof): every Gate-2 accept decided before this migration gets one
-- `unverifiable` row (`legacy_no_durable_evidence`) — no protected copy of its accepted bytes exists.
--
-- Foreign keys: default NO ACTION, never ON DELETE CASCADE (L-15); the graph stays acyclic (every
-- new edge points at decisions / requests / tasks / bundles / managed rows, nothing points back).

CREATE TABLE managed_evidence_bundles (
  digest                TEXT PRIMARY KEY
                          CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  result_envelope_hash  TEXT NOT NULL
                          CHECK (length(result_envelope_hash) = 64
                                 AND result_envelope_hash NOT GLOB '*[^0-9a-f]*'),
  managed_task_id       TEXT NOT NULL REFERENCES managed_tasks(id),
  run_id                TEXT NOT NULL REFERENCES managed_runs(id),
  rel_path              TEXT NOT NULL CHECK (rel_path = '_sealed/' || digest || '.bundle'),
  byte_len              INTEGER NOT NULL CHECK (byte_len > 0),
  item_count            INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 64),
  created_at            TEXT NOT NULL
);

CREATE INDEX idx_evidence_bundles_run ON managed_evidence_bundles(run_id);

ALTER TABLE managed_approval_requests
  ADD COLUMN evidence_bundle_digest TEXT REFERENCES managed_evidence_bundles(digest);

ALTER TABLE managed_decisions
  ADD COLUMN evidence_bundle_digest TEXT REFERENCES managed_evidence_bundles(digest);

CREATE TABLE managed_acceptance_validity (
  decision_id             TEXT PRIMARY KEY REFERENCES managed_decisions(id),
  result_request_id       TEXT NOT NULL UNIQUE REFERENCES managed_approval_requests(id),
  workspace_task_id       TEXT NOT NULL REFERENCES workspace_tasks(id),
  evidence_bundle_digest  TEXT REFERENCES managed_evidence_bundles(digest),
  status                  TEXT NOT NULL CHECK (status IN ('valid', 'invalid', 'unknown', 'unverifiable')),
  reason                  TEXT CHECK (reason IS NULL OR reason IN (
                            'bundle_missing', 'bundle_corrupt', 'bundle_binding_mismatch',
                            'source_evidence_changed', 'source_evidence_missing',
                            'candidate_unavailable', 'candidate_mismatch',
                            'verification_unavailable', 'legacy_no_durable_evidence')),
  detail                  TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  checked_at              TEXT NOT NULL,
  first_invalid_at        TEXT,
  rev                     INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  CHECK ((status = 'valid') = (reason IS NULL)),
  CHECK ((status = 'invalid') = (first_invalid_at IS NOT NULL)),
  CHECK ((status = 'unverifiable') = (reason IS 'legacy_no_durable_evidence')),
  CHECK (status <> 'unknown' OR reason = 'verification_unavailable'),
  CHECK (status <> 'invalid' OR reason IN (
           'bundle_missing', 'bundle_corrupt', 'bundle_binding_mismatch',
           'source_evidence_changed', 'source_evidence_missing',
           'candidate_unavailable', 'candidate_mismatch')),
  -- a legacy acceptance has no bundle; every other row names the bundle of its decision
  CHECK ((status = 'unverifiable') = (evidence_bundle_digest IS NULL))
);

CREATE INDEX idx_acceptance_validity_check ON managed_acceptance_validity(status, checked_at);
CREATE INDEX idx_acceptance_validity_task ON managed_acceptance_validity(workspace_task_id);

-- ── managed_evidence_bundles triggers (append-only) ──────────────────────────

CREATE TRIGGER managed_evidence_bundles_links BEFORE INSERT ON managed_evidence_bundles
BEGIN
  SELECT RAISE(ABORT, 'managed_evidence_bundles: run_id must be an attempt of managed_task_id')
  WHERE NOT EXISTS (SELECT 1 FROM managed_runs m
                    WHERE m.id = NEW.run_id AND m.task_id = NEW.managed_task_id);
END;

CREATE TRIGGER managed_evidence_bundles_no_update BEFORE UPDATE ON managed_evidence_bundles
BEGIN
  SELECT RAISE(ABORT, 'managed_evidence_bundles: rows are append-only');
END;

CREATE TRIGGER managed_evidence_bundles_no_delete BEFORE DELETE ON managed_evidence_bundles
BEGIN
  SELECT RAISE(ABORT, 'managed_evidence_bundles: rows are append-only');
END;

-- ── managed_approval_requests: the bundle digest ─────────────────────────────

CREATE TRIGGER managed_approval_requests_bundle_insert BEFORE INSERT ON managed_approval_requests
WHEN NEW.evidence_bundle_digest IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'managed_approval_requests: only a result request carries an evidence bundle, and the bundle must seal this envelope of this attempt')
  WHERE NEW.kind <> 'result'
     OR NOT EXISTS (SELECT 1 FROM managed_evidence_bundles b
                    WHERE b.digest = NEW.evidence_bundle_digest
                      AND b.result_envelope_hash = NEW.result_envelope_hash
                      AND b.managed_task_id = NEW.managed_task_id
                      AND b.run_id = NEW.run_id);
END;

CREATE TRIGGER managed_approval_requests_bundle_immutable BEFORE UPDATE ON managed_approval_requests
WHEN NEW.evidence_bundle_digest IS NOT OLD.evidence_bundle_digest
BEGIN
  SELECT RAISE(ABORT, 'managed_approval_requests: evidence_bundle_digest is immutable');
END;

-- ── managed_decisions: the accepted bundle ───────────────────────────────────

CREATE TRIGGER managed_decisions_bundle BEFORE INSERT ON managed_decisions
BEGIN
  SELECT RAISE(ABORT, 'managed_decisions: only a Gate-2 accept carries an evidence bundle digest')
  WHERE NEW.evidence_bundle_digest IS NOT NULL
    AND NOT (NEW.kind = 'result' AND NEW.action = 'accept');
  SELECT RAISE(ABORT, 'managed_decisions: a Gate-2 accept carries exactly its request''s evidence bundle digest')
  WHERE NEW.kind = 'result' AND NEW.action = 'accept'
    AND NEW.evidence_bundle_digest IS NOT (SELECT r.evidence_bundle_digest
                                           FROM managed_approval_requests r
                                           WHERE r.id = NEW.approval_request_id);
END;

-- ── managed_acceptance_validity triggers ─────────────────────────────────────

CREATE TRIGGER managed_acceptance_validity_insert BEFORE INSERT ON managed_acceptance_validity
BEGIN
  SELECT RAISE(ABORT, 'managed_acceptance_validity: a new row starts at rev 1, valid (or unverifiable for a legacy acceptance)')
  WHERE NEW.rev <> 1 OR NEW.status NOT IN ('valid', 'unverifiable');
  SELECT RAISE(ABORT, 'managed_acceptance_validity: the row must describe a Gate-2 accept of this request and task, with its evidence bundle')
  WHERE NOT EXISTS (SELECT 1 FROM managed_decisions d
                    WHERE d.id = NEW.decision_id AND d.kind = 'result' AND d.action = 'accept'
                      AND d.approval_request_id = NEW.result_request_id
                      AND d.workspace_task_id = NEW.workspace_task_id
                      AND d.evidence_bundle_digest IS NEW.evidence_bundle_digest);
END;

CREATE TRIGGER managed_acceptance_validity_update BEFORE UPDATE ON managed_acceptance_validity
BEGIN
  SELECT RAISE(ABORT, 'managed_acceptance_validity: invalid and unverifiable are sticky')
  WHERE OLD.status IN ('invalid', 'unverifiable');
  SELECT RAISE(ABORT, 'managed_acceptance_validity: rev must grow by exactly 1 on every update')
  WHERE NEW.rev IS NOT OLD.rev + 1;
  SELECT RAISE(ABORT, 'managed_acceptance_validity: identity columns are immutable')
  WHERE NEW.decision_id IS NOT OLD.decision_id
     OR NEW.result_request_id IS NOT OLD.result_request_id
     OR NEW.workspace_task_id IS NOT OLD.workspace_task_id
     OR NEW.evidence_bundle_digest IS NOT OLD.evidence_bundle_digest;
END;

CREATE TRIGGER managed_acceptance_validity_no_delete BEFORE DELETE ON managed_acceptance_validity
BEGIN
  SELECT RAISE(ABORT, 'managed_acceptance_validity: rows are history and are never deleted');
END;

-- ── backfill: acceptances decided before durable evidence existed ────────────

INSERT INTO managed_acceptance_validity
  (decision_id, result_request_id, workspace_task_id, evidence_bundle_digest, status, reason,
   detail, checked_at, first_invalid_at, rev)
SELECT d.id, d.approval_request_id, d.workspace_task_id, NULL, 'unverifiable',
       'legacy_no_durable_evidence',
       'accepted before durable evidence bundles existed; no protected copy of the accepted bytes was kept',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, 1
FROM managed_decisions d
WHERE d.kind = 'result' AND d.action = 'accept'
ORDER BY d.rowid;
