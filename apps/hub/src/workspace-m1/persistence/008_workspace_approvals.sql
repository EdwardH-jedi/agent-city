-- 008_workspace_approvals: workspace tasks, immutable proposal versions, approval requests (Gate 1 =
-- run, Gate 2 = result) and append-only decisions with durable receipts. Contract:
-- packages/schema/src/workspace-m1/INTERFACE.md §4 (DTOs: rows.ts). Additive only: no managed_* table
-- is altered; the linkage to the engine lives in these tables.
--
-- Foreign keys (all default NO ACTION; never ON DELETE CASCADE — lead ruling L-15):
--   * Every FK points DOWN the ownership tree (decision → request → proposal → workspace task) or OUT
--     to managed_tasks / managed_runs. The FK graph has no cycle.
--   * The two UP pointers on workspace_tasks (current_proposal_id, accepted_decision_id) are plain
--     columns validated by triggers (exists, same workspace task, and for accepted_decision_id: a
--     Gate-2 `accept`). They are equally enforceable because their targets can never disappear:
--     managed_proposals and managed_decisions refuse DELETE (and UPDATE).
--   * A managed task / run referenced here can no longer be deleted (managed_runs cascades from
--     managed_tasks, and the NO ACTION FKs below then fail the whole delete) — history is kept.
--   * Write order this imposes (immediate checks): insert the child rows first, then point at them
--     (proposal → reserved managed task → run request → workspace_tasks pointers).
--
-- Additive to §4 (mirrors rows.ts / state.ts, enforced for every writer, not only the 02 store):
-- rev must grow by exactly 1 on every UPDATE; identity/binding columns are immutable; a closed
-- (non-pending) approval request never changes again; a terminal (accepted / rejected) workspace task
-- never changes again; workspace tasks and approval requests are never deleted (history/retention).

CREATE TABLE workspace_tasks (
  id                       TEXT PRIMARY KEY,
  contract_version         TEXT NOT NULL CHECK (contract_version = 'agentcity.workspace-task/v1'),
  repo_id                  TEXT NOT NULL,
  created_by               TEXT NOT NULL,
  idempotency_key          TEXT NOT NULL,            -- create-command retry key
  request_hash             TEXT NOT NULL,            -- H({repo_id, draft}) of the create command
  draft                    TEXT NOT NULL CHECK (json_valid(draft)),  -- mutable working copy (JSON)
  stage                    TEXT NOT NULL CHECK (stage IN (
                             'draft', 'awaiting_run_approval', 'queued', 'running', 'cancel_requested',
                             'awaiting_acceptance', 'accepted', 'rejected', 'changes_requested',
                             'execution_ended', 'cancelled')),
  stage_detail             TEXT,
  current_proposal_id      TEXT,                     -- → managed_proposals(id), trigger-validated
  current_managed_task_id  TEXT REFERENCES managed_tasks(id),
  accepted_decision_id     TEXT,                     -- → managed_decisions(id), trigger-validated
  cancel_requested_at      TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  rev                      INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  UNIQUE (created_by, idempotency_key),
  CHECK ((stage = 'accepted') = (accepted_decision_id IS NOT NULL)),
  -- rows.ts: these stages always point at a current proposal and managed task
  CHECK (stage NOT IN ('awaiting_run_approval', 'queued', 'running', 'cancel_requested',
                       'awaiting_acceptance', 'accepted')
         OR (current_proposal_id IS NOT NULL AND current_managed_task_id IS NOT NULL)),
  CHECK (stage <> 'cancel_requested' OR cancel_requested_at IS NOT NULL)
);

-- A managed task is the current execution of at most one workspace task (NULLs are distinct).
CREATE UNIQUE INDEX idx_workspace_tasks_managed ON workspace_tasks(current_managed_task_id);
CREATE INDEX idx_workspace_tasks_updated ON workspace_tasks(updated_at, id);

CREATE TABLE managed_proposals (
  id                       TEXT PRIMARY KEY,
  workspace_task_id        TEXT NOT NULL REFERENCES workspace_tasks(id),
  version                  INTEGER NOT NULL CHECK (version >= 1),
  predecessor_proposal_id  TEXT REFERENCES managed_proposals(id),
  contract_version         TEXT NOT NULL CHECK (contract_version = 'agentcity.proposal/v1'),
  snapshot                 TEXT NOT NULL CHECK (json_valid(snapshot)),  -- canonical JSON, verbatim
  proposal_hash            TEXT NOT NULL UNIQUE,                        -- sha256(snapshot)
  created_by               TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  UNIQUE (workspace_task_id, version),
  CHECK ((version = 1) = (predecessor_proposal_id IS NULL))
);

CREATE TABLE managed_approval_requests (
  id                            TEXT PRIMARY KEY,
  workspace_task_id             TEXT NOT NULL REFERENCES workspace_tasks(id),
  kind                          TEXT NOT NULL CHECK (kind IN ('run', 'result')),
  proposal_id                   TEXT NOT NULL REFERENCES managed_proposals(id),
  proposal_hash                 TEXT NOT NULL,
  managed_task_id               TEXT NOT NULL REFERENCES managed_tasks(id),
  execution_binding             TEXT NOT NULL CHECK (json_valid(execution_binding)),  -- canonical
  execution_binding_hash        TEXT NOT NULL,
  run_id                        TEXT REFERENCES managed_runs(id),
  result_envelope               TEXT CHECK (result_envelope IS NULL OR json_valid(result_envelope)),
  result_envelope_hash          TEXT,
  binding                       TEXT NOT NULL CHECK (json_valid(binding)),            -- canonical
  binding_hash                  TEXT NOT NULL UNIQUE,
  status                        TEXT NOT NULL CHECK (status IN (
                                  'pending', 'approved', 'accepted', 'changes_requested', 'rejected',
                                  'invalidated')),
  invalidation_reason           TEXT CHECK (invalidation_reason IS NULL OR invalidation_reason IN (
                                  'proposal_superseded', 'withdrawn', 'policy_changed',
                                  'repo_unavailable', 'execution_ended', 'task_cancelled',
                                  'evidence_unavailable', 'integrity_failed', 'candidate_mutated')),
  invalidation_detail           TEXT,
  created_at                    TEXT NOT NULL,
  updated_at                    TEXT NOT NULL,
  closed_at                     TEXT,
  rev                           INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  -- challenge (server-only; never serialized to clients; the token itself is never stored)
  challenge_status              TEXT NOT NULL DEFAULT 'none'
                                  CHECK (challenge_status IN ('none', 'issued', 'consumed')),
  challenge_hash                TEXT,
  challenge_operator_id         TEXT,
  challenge_session_generation  INTEGER,
  challenge_boot_id             TEXT,
  challenge_request_rev         INTEGER,
  challenge_issued_at           TEXT,
  challenge_expires_at          TEXT,
  CHECK (CASE kind
           WHEN 'run' THEN run_id IS NULL AND result_envelope IS NULL AND result_envelope_hash IS NULL
           ELSE run_id IS NOT NULL AND result_envelope IS NOT NULL AND result_envelope_hash IS NOT NULL
         END),
  CHECK ((status = 'pending') = (closed_at IS NULL)),
  CHECK ((status = 'invalidated') = (invalidation_reason IS NOT NULL)),
  CHECK (NOT (kind = 'run' AND status = 'accepted') AND NOT (kind = 'result' AND status = 'approved')),
  CHECK (CASE challenge_status
           WHEN 'none' THEN challenge_hash IS NULL AND challenge_operator_id IS NULL
             AND challenge_session_generation IS NULL AND challenge_boot_id IS NULL
             AND challenge_request_rev IS NULL AND challenge_issued_at IS NULL
             AND challenge_expires_at IS NULL
           ELSE challenge_hash IS NOT NULL AND challenge_operator_id IS NOT NULL
             AND challenge_session_generation IS NOT NULL AND challenge_boot_id IS NOT NULL
             AND challenge_request_rev IS NOT NULL AND challenge_issued_at IS NOT NULL
             AND challenge_expires_at IS NOT NULL
         END)
);

-- One Gate 1 per managed task (ever); one Gate 2 per attempt (ever); one pending request per gate.
CREATE UNIQUE INDEX idx_approval_run_per_managed_task
  ON managed_approval_requests(managed_task_id) WHERE kind = 'run';
CREATE UNIQUE INDEX idx_approval_result_per_run
  ON managed_approval_requests(run_id) WHERE kind = 'result';
CREATE UNIQUE INDEX idx_approval_one_pending
  ON managed_approval_requests(workspace_task_id, kind) WHERE status = 'pending';
CREATE INDEX idx_approval_task ON managed_approval_requests(workspace_task_id, created_at);
CREATE INDEX idx_approval_status ON managed_approval_requests(status, created_at);

CREATE TABLE managed_decisions (
  id                    TEXT PRIMARY KEY,
  approval_request_id   TEXT NOT NULL UNIQUE REFERENCES managed_approval_requests(id),
  workspace_task_id     TEXT NOT NULL REFERENCES workspace_tasks(id),
  kind                  TEXT NOT NULL CHECK (kind IN ('run', 'result')),
  action                TEXT NOT NULL CHECK (action IN ('approve', 'accept', 'request_changes', 'reject')),
  operator_id           TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL,
  payload_hash          TEXT NOT NULL,
  binding_hash          TEXT NOT NULL,
  request_rev           INTEGER NOT NULL CHECK (request_rev >= 1),
  confirmation_text     TEXT CHECK (confirmation_text IS NULL OR confirmation_text = 'Edward'),
  reason                TEXT,
  boot_id               TEXT NOT NULL,
  session_generation    INTEGER NOT NULL CHECK (session_generation >= 1),
  managed_task_id       TEXT NOT NULL REFERENCES managed_tasks(id),
  result_envelope_hash  TEXT,
  decided_at            TEXT NOT NULL,
  response_status       INTEGER NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  response_body         TEXT NOT NULL CHECK (json_valid(response_body)),  -- receipt, replayed verbatim
  UNIQUE (operator_id, idempotency_key),
  CHECK ((kind = 'run' AND action IN ('approve', 'request_changes', 'reject'))
      OR (kind = 'result' AND action IN ('accept', 'request_changes', 'reject'))),
  CHECK ((action IN ('approve', 'accept')) = (confirmation_text IS NOT NULL)),
  CHECK ((action IN ('approve', 'accept')) = (reason IS NULL)),
  CHECK ((kind = 'result') = (result_envelope_hash IS NOT NULL))
);

CREATE INDEX idx_decisions_task ON managed_decisions(workspace_task_id, decided_at);

-- ── workspace_tasks triggers ─────────────────────────────────────────────────

CREATE TRIGGER workspace_tasks_insert_shape BEFORE INSERT ON workspace_tasks
BEGIN
  SELECT RAISE(ABORT, 'workspace_tasks: a new task starts in draft at rev 1 and points at nothing')
  WHERE NEW.stage <> 'draft' OR NEW.rev <> 1 OR NEW.current_proposal_id IS NOT NULL
     OR NEW.current_managed_task_id IS NOT NULL OR NEW.accepted_decision_id IS NOT NULL
     OR NEW.cancel_requested_at IS NOT NULL;
END;

CREATE TRIGGER workspace_tasks_update_rules BEFORE UPDATE ON workspace_tasks
BEGIN
  SELECT RAISE(ABORT, 'workspace_tasks: accepted and rejected tasks are terminal')
  WHERE OLD.stage IN ('accepted', 'rejected');
  SELECT RAISE(ABORT, 'workspace_tasks: rev must grow by exactly 1 on every update')
  WHERE NEW.rev IS NOT OLD.rev + 1;
  SELECT RAISE(ABORT, 'workspace_tasks: identity columns are immutable')
  WHERE NEW.id IS NOT OLD.id OR NEW.contract_version IS NOT OLD.contract_version
     OR NEW.repo_id IS NOT OLD.repo_id OR NEW.created_by IS NOT OLD.created_by
     OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.request_hash IS NOT OLD.request_hash
     OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'workspace_tasks: current pointers are never cleared')
  WHERE (OLD.current_proposal_id IS NOT NULL AND NEW.current_proposal_id IS NULL)
     OR (OLD.current_managed_task_id IS NOT NULL AND NEW.current_managed_task_id IS NULL);
  SELECT RAISE(ABORT, 'workspace_tasks: current_proposal_id must name a proposal of this task')
  WHERE NEW.current_proposal_id IS NOT OLD.current_proposal_id
    AND NOT EXISTS (SELECT 1 FROM managed_proposals p
                    WHERE p.id = NEW.current_proposal_id AND p.workspace_task_id = NEW.id);
  SELECT RAISE(ABORT, 'workspace_tasks: current_managed_task_id must have a run request of this task for current_proposal_id')
  WHERE NEW.current_managed_task_id IS NOT NULL
    AND (NEW.current_managed_task_id IS NOT OLD.current_managed_task_id
         OR NEW.current_proposal_id IS NOT OLD.current_proposal_id)
    AND NOT EXISTS (SELECT 1 FROM managed_approval_requests r
                    WHERE r.kind = 'run' AND r.workspace_task_id = NEW.id
                      AND r.managed_task_id = NEW.current_managed_task_id
                      AND r.proposal_id = NEW.current_proposal_id);
  SELECT RAISE(ABORT, 'workspace_tasks: accepted_decision_id must name a Gate-2 accept of this task and execution')
  WHERE NEW.accepted_decision_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM managed_decisions d
                    WHERE d.id = NEW.accepted_decision_id AND d.workspace_task_id = NEW.id
                      AND d.kind = 'result' AND d.action = 'accept'
                      AND d.managed_task_id = NEW.current_managed_task_id);
END;

CREATE TRIGGER workspace_tasks_no_delete BEFORE DELETE ON workspace_tasks
BEGIN
  SELECT RAISE(ABORT, 'workspace_tasks: rows are history and are never deleted');
END;

-- ── managed_proposals triggers (immutable) ───────────────────────────────────

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

-- ── managed_approval_requests triggers ───────────────────────────────────────

CREATE TRIGGER managed_approval_requests_links BEFORE INSERT ON managed_approval_requests
BEGIN
  SELECT RAISE(ABORT, 'managed_approval_requests: proposal must belong to the task and carry its hash')
  WHERE NOT EXISTS (SELECT 1 FROM managed_proposals p
                    WHERE p.id = NEW.proposal_id AND p.workspace_task_id = NEW.workspace_task_id
                      AND p.proposal_hash = NEW.proposal_hash);
  SELECT RAISE(ABORT, 'managed_approval_requests: run_id must be an attempt of managed_task_id')
  WHERE NEW.run_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM managed_runs m
                    WHERE m.id = NEW.run_id AND m.task_id = NEW.managed_task_id);
  SELECT RAISE(ABORT, 'managed_approval_requests: a result request needs the approved run request of the same execution')
  WHERE NEW.kind = 'result'
    AND NOT EXISTS (SELECT 1 FROM managed_approval_requests g
                    WHERE g.kind = 'run' AND g.status = 'approved'
                      AND g.workspace_task_id = NEW.workspace_task_id
                      AND g.managed_task_id = NEW.managed_task_id
                      AND g.proposal_id = NEW.proposal_id
                      AND g.execution_binding_hash = NEW.execution_binding_hash);
  SELECT RAISE(ABORT, 'managed_approval_requests: a new request starts at rev 1 with no challenge')
  WHERE NEW.rev <> 1 OR NEW.challenge_status <> 'none';
END;

CREATE TRIGGER managed_approval_requests_update_rules BEFORE UPDATE ON managed_approval_requests
BEGIN
  SELECT RAISE(ABORT, 'managed_approval_requests: a closed request never changes')
  WHERE OLD.status <> 'pending';
  SELECT RAISE(ABORT, 'managed_approval_requests: rev must grow by exactly 1 on every update')
  WHERE NEW.rev IS NOT OLD.rev + 1;
  SELECT RAISE(ABORT, 'managed_approval_requests: subject and binding columns are immutable')
  WHERE NEW.id IS NOT OLD.id OR NEW.workspace_task_id IS NOT OLD.workspace_task_id
     OR NEW.kind IS NOT OLD.kind OR NEW.proposal_id IS NOT OLD.proposal_id
     OR NEW.proposal_hash IS NOT OLD.proposal_hash OR NEW.managed_task_id IS NOT OLD.managed_task_id
     OR NEW.execution_binding IS NOT OLD.execution_binding
     OR NEW.execution_binding_hash IS NOT OLD.execution_binding_hash
     OR NEW.run_id IS NOT OLD.run_id OR NEW.result_envelope IS NOT OLD.result_envelope
     OR NEW.result_envelope_hash IS NOT OLD.result_envelope_hash
     OR NEW.binding IS NOT OLD.binding OR NEW.binding_hash IS NOT OLD.binding_hash
     OR NEW.created_at IS NOT OLD.created_at;
END;

CREATE TRIGGER managed_approval_requests_no_delete BEFORE DELETE ON managed_approval_requests
BEGIN
  SELECT RAISE(ABORT, 'managed_approval_requests: rows are history and are never deleted');
END;

-- ── managed_decisions triggers (append-only) ─────────────────────────────────

CREATE TRIGGER managed_decisions_match_request BEFORE INSERT ON managed_decisions
BEGIN
  SELECT RAISE(ABORT, 'managed_decisions: decision must match its approval request (task, kind, binding, execution, envelope) and the request must be pending or closed by this action')
  WHERE NOT EXISTS (
    SELECT 1 FROM managed_approval_requests r
    WHERE r.id = NEW.approval_request_id
      AND r.workspace_task_id = NEW.workspace_task_id
      AND r.kind = NEW.kind
      AND r.binding_hash = NEW.binding_hash
      AND r.managed_task_id = NEW.managed_task_id
      AND r.result_envelope_hash IS NEW.result_envelope_hash
      AND r.status IN ('pending', CASE NEW.action
                                    WHEN 'approve' THEN 'approved'
                                    WHEN 'accept' THEN 'accepted'
                                    WHEN 'request_changes' THEN 'changes_requested'
                                    ELSE 'rejected'
                                  END));
END;

CREATE TRIGGER managed_decisions_no_update BEFORE UPDATE ON managed_decisions
BEGIN
  SELECT RAISE(ABORT, 'managed_decisions: rows are append-only');
END;

CREATE TRIGGER managed_decisions_no_delete BEFORE DELETE ON managed_decisions
BEGIN
  SELECT RAISE(ABORT, 'managed_decisions: rows are append-only');
END;
