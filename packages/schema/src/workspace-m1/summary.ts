import type { RepositoryCategories } from "./api.ts";
import type { AcceptanceValidityStatus } from "./rows.ts";
import type { WorkspacePhase } from "./state.ts";
export const emptyCategories = (): RepositoryCategories => ({
	running: 0,
	queued: 0,
	cancelRequested: 0,
	needsApproval: 0,
	needsAcceptance: 0,
	attention: 0,
	cancelled: 0,
	accepted: 0,
	rejected: 0,
	drafts: 0,
});
export function repositoryCategory(
	phase: WorkspacePhase,
	validity: AcceptanceValidityStatus | null,
	quarantined = false,
): keyof RepositoryCategories {
	if (phase === "awaiting_run_approval") return "needsApproval";
	if (phase === "awaiting_acceptance") return "needsAcceptance";
	if (
		quarantined ||
		["failed", "blocked", "interrupted"].includes(phase) ||
		(phase === "accepted" &&
			(validity === "invalid" || validity === "unknown" || validity === null))
	)
		return "attention";
	if (phase === "queued") return "queued";
	if (
		[
			"implementing",
			"verifying",
			"reviewing",
			"repairing",
			"finalizing",
		].includes(phase)
	)
		return "running";
	if (phase === "cancel_requested") return "cancelRequested";
	if (phase === "cancelled" || phase === "accepted" || phase === "rejected")
		return phase;
	return "drafts";
}
