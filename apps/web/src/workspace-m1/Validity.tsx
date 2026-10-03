// Current acceptance validity (role 07, contract delta v1.2 — CONTRACT_V1_2.md §C). Shown next to the
// historical acceptance (`#acceptance-status` stays `accepted`). Renders exactly the hub's
// `acceptance_validity`; never a "verified" reading unless the hub says `valid`. Only `invalid` is an
// alert (role=alert, no Dismiss: it describes the record, not a transient error).
// Freshness (UI policy, labels.ts `validityFreshness`; NOTES.md "Validity freshness"): the age of the
// hub's last check is shown next to it; past VALIDITY_STALE_AFTER_MS, or with an offline / stale
// connection, a `valid` reading is no longer green and says it may be out of date. `data-status`
// always stays the hub's status.
import type {
	AcceptanceValidityView,
	WorkspaceTaskDetail,
} from "@agent-city/schema/workspace-m1";
import {
	acceptanceValidityDisplay,
	acceptedResultRequest,
	type ValidityFreshness,
	validityFreshness,
	validityShortLabel,
} from "./labels.ts";

/** Freshness of a reported validity for this client (`now` = this browser's clock). */
export function freshnessOf(
	v: AcceptanceValidityView | null | undefined,
	conn: { status: string; lastConfirmedAt: string | null },
	now: number = Date.now(),
): ValidityFreshness | null {
	return v ? validityFreshness(v.checked_at, now, conn) : null;
}

/** decided_at of the accept decision the validity is about (history), if known. */
export function acceptedAtOf(
	d: Pick<WorkspaceTaskDetail, "decisions" | "approval_requests">,
	v: AcceptanceValidityView | null | undefined,
): string | null {
	const byId = v ? d.decisions.find((x) => x.id === v.decision_id) : undefined;
	if (byId) return byId.decided_at;
	const req = acceptedResultRequest(d);
	const dec = req
		? d.decisions.find(
				(x) => x.approval_request_id === req.id && x.action === "accept",
			)
		: undefined;
	return dec?.decided_at ?? null;
}

/**
 * `#acceptance-validity[data-status]` — one per mounted view (task detail, or the HQ result
 * document). `data-status` ∈ valid | invalid | unknown | unverifiable (`unknown` +
 * `data-reason=not_reported` when the hub sent no validity for an accepted result).
 */
export function AcceptanceValidityBlock({
	detail,
	freshness = null,
}: {
	detail: Pick<
		WorkspaceTaskDetail,
		"decisions" | "approval_requests" | "acceptance_validity"
	>;
	/** UI freshness of the reading (`freshnessOf`); null = no freshness line. */
	freshness?: ValidityFreshness | null;
}) {
	const v = detail.acceptance_validity ?? null;
	const view = acceptanceValidityDisplay(v, acceptedAtOf(detail, v), freshness);
	return (
		<div
			className={`wsm1-validity wsm1-banner wsm1-tone-${view.tone}`}
			data-testid="acceptance-validity"
			data-status={view.status}
			data-reason={view.reason ?? "none"}
			data-freshness={view.freshness ?? "none"}
			role={view.alert ? "alert" : undefined}
		>
			<p>
				<strong>Current validity: </strong>
				{view.text}
			</p>
			{view.note ? <p className="wsm1-validity-note">{view.note}</p> : null}
			{v && freshness ? (
				<p
					className={`wsm1-validity-freshness${freshness.stale ? " wsm1-validity-stale" : ""}`}
					data-testid="validity-freshness"
					data-stale={freshness.stale ? "true" : "false"}
					data-cause={freshness.cause}
				>
					{freshness.line}
				</p>
			) : null}
		</div>
	);
}

/**
 * The one-line history form (Decision history); its own test id. An `invalid` validity is a visible
 * warning here too, and the announced (role=alert, non-dismissable) one when `announce` is set — the
 * caller sets it when no other alert for this acceptance is mounted in the view (one alert per view).
 */
export function ValidityHistoryLine({
	validity,
	freshness = null,
	announce = false,
}: {
	validity: AcceptanceValidityView | null | undefined;
	freshness?: ValidityFreshness | null;
	announce?: boolean;
}) {
	const invalid = validity?.status === "invalid";
	return (
		<span
			className={invalid ? "wsm1-history-invalid" : undefined}
			data-testid="history-acceptance-validity"
			data-status={validity?.status ?? "unknown"}
			data-freshness={
				validity && freshness ? (freshness.stale ? "stale" : "fresh") : "none"
			}
			role={invalid && announce ? "alert" : undefined}
		>
			Accepted · {validityShortLabel(validity, freshness)}
		</span>
	);
}
