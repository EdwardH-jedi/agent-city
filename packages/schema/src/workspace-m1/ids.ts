// Workspace M1 identifiers (web-safe: zod + pure TS). Every id is `<prefix>-<uuid>`; the hub mints
// them (hash.ts `newWorkspaceId`), clients only echo them. Meanings (INTERFACE.md §1):
//
//   wst-  workspace task      stable unit of work the operator sees; owns the mutable draft
//   wsp-  proposal            immutable, hashed snapshot of one draft = proposal version N of a task
//   wsa-  approval request    one gate (run | result) over one immutable subject binding
//   wsd-  decision            append-only human decision + durable receipt for one approval request
//   task- managed task        ONE bounded engine execution of exactly one proposal version (existing)
//   run-  attempt             one managed_runs row; attempt_no 1 = initial, 2 = the single repair
//   art-  artifact            one stored evidence file of an attempt (existing)
//   rev-  review              one reviewer verdict row of an attempt (existing)
//
// A candidate has no id of its own: it is the tuple (run_id, candidate_sha, candidate_tree,
// manifest_hash). New prefixes use strict lowercase uuid v4; existing engine prefixes keep the
// looser form their routes already accept (`^task-[0-9a-f-]{36}$`), so legacy/test rows still parse.
import { z } from "zod";

const UUID_V4 =
	"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const LOOSE_UUID = "[0-9a-f-]{36}";

export const WORKSPACE_ID_PREFIXES = ["wst", "wsp", "wsa", "wsd"] as const;
export type WorkspaceIdPrefix = (typeof WORKSPACE_ID_PREFIXES)[number];

export const WORKSPACE_ID_PATTERNS: Readonly<
	Record<WorkspaceIdPrefix, RegExp>
> = {
	wst: new RegExp(`^wst-${UUID_V4}$`),
	wsp: new RegExp(`^wsp-${UUID_V4}$`),
	wsa: new RegExp(`^wsa-${UUID_V4}$`),
	wsd: new RegExp(`^wsd-${UUID_V4}$`),
};

export const WorkspaceTaskId = z
	.string()
	.regex(WORKSPACE_ID_PATTERNS.wst, "workspace task id (wst-<uuid v4>)");
export type WorkspaceTaskId = z.infer<typeof WorkspaceTaskId>;

export const ProposalId = z
	.string()
	.regex(WORKSPACE_ID_PATTERNS.wsp, "proposal id (wsp-<uuid v4>)");
export type ProposalId = z.infer<typeof ProposalId>;

export const ApprovalRequestId = z
	.string()
	.regex(WORKSPACE_ID_PATTERNS.wsa, "approval request id (wsa-<uuid v4>)");
export type ApprovalRequestId = z.infer<typeof ApprovalRequestId>;

export const DecisionId = z
	.string()
	.regex(WORKSPACE_ID_PATTERNS.wsd, "decision id (wsd-<uuid v4>)");
export type DecisionId = z.infer<typeof DecisionId>;

/** Existing engine ids (apps/hub/src/managed/store.ts `newId`). Same form as routes/managed.ts. */
export const ManagedTaskId = z
	.string()
	.regex(new RegExp(`^task-${LOOSE_UUID}$`), "managed task id (task-<uuid>)");
export type ManagedTaskId = z.infer<typeof ManagedTaskId>;

export const RunId = z
	.string()
	.regex(new RegExp(`^run-${LOOSE_UUID}$`), "run id (run-<uuid>)");
export type RunId = z.infer<typeof RunId>;

export const ArtifactId = z
	.string()
	.regex(new RegExp(`^art-${LOOSE_UUID}$`), "artifact id (art-<uuid>)");
export type ArtifactId = z.infer<typeof ArtifactId>;

export const ReviewId = z
	.string()
	.regex(new RegExp(`^rev-${LOOSE_UUID}$`), "review id (rev-<uuid>)");
export type ReviewId = z.infer<typeof ReviewId>;

/** Hub process generation: minted once per hub start; every challenge/session is bound to it. */
export const BootId = z
	.string()
	.regex(new RegExp(`^boot-${UUID_V4}$`), "boot id (boot-<uuid v4>)");
export type BootId = z.infer<typeof BootId>;

/** Client-generated retry key. Same rule as the existing TaskSubmission.idempotency_key. */
export const IdempotencyKey = z
	.string()
	.regex(/^[A-Za-z0-9._-]{8,128}$/, "idempotency key ([A-Za-z0-9._-]{8,128})");
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;
