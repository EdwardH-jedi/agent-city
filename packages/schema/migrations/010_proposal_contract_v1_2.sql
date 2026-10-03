-- 010_proposal_contract_v1_2: let managed_proposals hold ProposalSnapshot v1.2 (contract delta v1.2 §A,
-- docs/workspace-m1/CONTRACT_V1_2.md; DTO: rows.ts ManagedProposalRow, contract v1 | v1.2).
--
-- Why a rebuild: 008 declares `contract_version CHECK (contract_version = 'agentcity.proposal/v1')`.
-- SQLite cannot alter a CHECK in place and 008 is never edited, so this migration rebuilds the table
-- with the same columns (same order), the same keys and foreign keys, and the CHECK widened to
-- v1 | v1.2 — plus a new CHECK that the column names the stored snapshot's own `contract`. Every
-- existing (v1) row is copied verbatim; the three 008 triggers of this table are re-created
-- verbatim (proposals stay immutable, never deleted, versions contiguous).
--
-- How (inside db.ts's single migration transaction, foreign keys ON):
--   * `defer_foreign_keys` defers every FK check to COMMIT (resets automatically at COMMIT);
--   * rows → TEMP copy; DROP TABLE (its implicit delete fires no trigger and only increments the
--     deferred FK counter for the requests / successors that reference these rows);
--   * CREATE the new table under the SAME name (no RENAME: references in other tables' FKs and
--     triggers keep resolving by name) and re-insert the rows — each re-inserted parent row
--     decrements that counter, so COMMIT succeeds exactly when every reference is restored.
-- Nothing else changes: no other table, index or trigger is touched.

PRAGMA defer_foreign_keys = ON;

CREATE TEMP TABLE managed_proposals_010_copy AS
  SELECT * FROM main.managed_proposals ORDER BY rowid;

DROP TABLE main.managed_proposals;

CREATE TABLE managed_proposals (
  id                       TEXT PRIMARY KEY,
  workspace_task_id        TEXT NOT NULL REFERENCES workspace_tasks(id),
  version                  INTEGER NOT NULL CHECK (version >= 1),
  predecessor_proposal_id  TEXT REFERENCES managed_proposals(id),
  contract_version         TEXT NOT NULL CHECK (contract_version IN (
                             'agentcity.proposal/v1', 'agentcity.proposal/v1.2')),
  snapshot                 TEXT NOT NULL CHECK (json_valid(snapshot)),  -- canonical JSON, verbatim
  proposal_hash            TEXT NOT NULL UNIQUE,                        -- sha256(snapshot)
  created_by               TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  UNIQUE (workspace_task_id, version),
  CHECK ((version = 1) = (predecessor_proposal_id IS NULL)),
  -- the column is the snapshot's own contract (a v1.2 snapshot never hides behind a v1 label)
  CHECK (json_extract(snapshot, '$.contract') = contract_version)
);

INSERT INTO main.managed_proposals
  (id, workspace_task_id, version, predecessor_proposal_id, contract_version, snapshot,
   proposal_hash, created_by, created_at)
SELECT id, workspace_task_id, version, predecessor_proposal_id, contract_version, snapshot,
       proposal_hash, created_by, created_at
FROM temp.managed_proposals_010_copy ORDER BY rowid;

DROP TABLE temp.managed_proposals_010_copy;

-- ── managed_proposals triggers (immutable) — verbatim from 008 ───────────────

CREATE TRIGGER managed_proposals_lineage BEFORE INSERT ON managed_proposals
BEGIN
  SELECT RAISE(ABORT, 'managed_proposals: version N > 1 must name version N-1 of the same task')
  WHERE NEW.predecessor_proposal_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM managed_proposals p
                    WHERE p.id = NEW.predecessor_proposal_id
                      AND p.workspace_task_id = NEW.workspace_task_id
                      AND p.version = NEW.version - 1);
END;

CREATE TRIGGER managed_proposals_no_update BEFORE UPDATE ON managed_proposals
BEGIN
  SELECT RAISE(ABORT, 'managed_proposals: rows are immutable');
END;

CREATE TRIGGER managed_proposals_no_delete BEFORE DELETE ON managed_proposals
BEGIN
  SELECT RAISE(ABORT, 'managed_proposals: rows are immutable');
END;
