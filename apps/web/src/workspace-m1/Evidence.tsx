// Evidence list and the inert evidence viewer (role 07). Content is rendered ONLY as React text
// inside <pre> (never HTML). Statuses come from the sealed result envelope; content the server
// could not verify or disclose is never shown (R-E3: withheld → fixed placeholder + reason codes).
import type {
	ApprovalRequestView,
	ArtifactListItem,
	EnvelopeArtifact,
	WorkspaceTaskDetail,
} from "@agent-city/schema/workspace-m1";
import { useEffect, useRef } from "react";
import { CriterionCoverageView } from "./Coverage.tsx";
import {
	ACCEPTANCE_SCOPE_NOTE,
	ACCEPTED_ORIGINAL_NOTE,
	ACCEPTED_STALE_EVIDENCE_LABEL,
	acceptedHistory,
	acceptedResultRequest,
	EVIDENCE_LABEL,
	evidenceStatus,
	evidenceStatusLabel,
	INVALIDATION_LABEL,
	resultRevocation,
	shortHash,
	validityShortLabel,
} from "./labels.ts";
import { Chip, KV, Mono, useWs } from "./parts.tsx";
import type { ViewerState } from "./store.ts";
import { freshnessOf } from "./Validity.tsx";

const artifactDomId = (id: string) => `wsm1-art-${id}`;

function envelopeItem(
	d: Pick<WorkspaceTaskDetail, "approval_requests">,
	a: Pick<ArtifactListItem, "run_id" | "name">,
): EnvelopeArtifact | null {
	const req = d.approval_requests.find(
		(r) => r.kind === "result" && r.run_id === a.run_id,
	);
	return req?.result_envelope?.artifacts.find((x) => x.name === a.name) ?? null;
}

const toneOf = (status: string) =>
	status === "verified"
		? "ok"
		: status === "truncated" || status === "withheld" || status === "pending"
			? "waiting"
			: "bad";

/** Result identity + checks + review of one result request (Gate 2 subject). */
export function ResultSummary({
	request,
	detail,
}: {
	request: ApprovalRequestView;
	detail?: Pick<
		WorkspaceTaskDetail,
		"approval_requests" | "acceptance_validity" | "current_proposal"
	> | null;
}) {
	const env = request.result_envelope;
	if (!env) return null;
	const history =
		request.status === "accepted" && detail ? acceptedHistory(detail) : null;
	return (
		<div className="wsm1-block">
			<h3>
				{request.status === "accepted"
					? "Accepted result"
					: "Result under review"}
			</h3>
			{history !== null ? (
				<p className="wsm1-banner wsm1-tone-waiting">
					This result was accepted. Current validity:{" "}
					{validityShortLabel(detail?.acceptance_validity)}. The identities and
					statuses below are what was sealed and accepted; they are kept as
					history and are not current verification.
				</p>
			) : null}
			{request.status === "invalidated" && request.invalidation_reason ? (
				<p className="wsm1-banner wsm1-tone-bad">
					This result was invalidated:{" "}
					{INVALIDATION_LABEL[request.invalidation_reason]}. The identities and
					statuses below are what was sealed; they are kept for history and
					cannot be accepted.
				</p>
			) : null}
			<CriterionCoverageView
				envelope={env}
				proposal={
					detail?.current_proposal &&
					detail.current_proposal.id === request.proposal_id
						? detail.current_proposal.snapshot
						: null
				}
			/>
			<dl className="wsm1-kvs">
				<KV label="Candidate">
					<Mono value={env.candidate_sha} testId="candidate-sha" />
				</KV>
				<KV label="Attempt">
					<code
						className="wsm1-mono"
						data-testid="attempt-id"
						data-attempt-number={env.attempt_no}
					>
						{env.run_id}
					</code>{" "}
					(attempt {env.attempt_no} of at most {1 + env.max_repairs})
				</KV>
				<KV label="Execution">
					<Mono value={env.managed_task_id} />
				</KV>
				<KV label="Candidate tree">
					<Mono value={env.candidate_tree} />
				</KV>
				<KV label="Parent / base">
					<Mono value={env.parent_sha} /> / <Mono value={env.base_sha} />
				</KV>
				<KV label="Manifest">
					<Mono value={env.manifest_hash} />
				</KV>
				<KV label="Result envelope">
					<Mono value={request.result_envelope_hash ?? "—"} />
				</KV>
				<KV label="Provenance">
					implementer {env.provenance.implementer.provider} /{" "}
					{env.provenance.implementer.mode}, reviewer{" "}
					{env.provenance.reviewer.provider} / {env.provenance.reviewer.mode} ·
					model not reported
				</KV>
			</dl>
			<h4>Verification results</h4>
			<table className="wsm1-table">
				<thead>
					<tr>
						<th scope="col">Check</th>
						<th scope="col">Result</th>
						<th scope="col">Exit</th>
						<th scope="col">Duration</th>
						<th scope="col">Log</th>
					</tr>
				</thead>
				<tbody>
					{env.verification.map((c) => {
						const passed = c.completed && !c.timed_out && c.exit_code === 0;
						return (
							<tr key={c.name}>
								<th scope="row">{c.name}</th>
								<td>
									<Chip tone={passed ? "ok" : "bad"}>
										{passed ? "Passed" : c.timed_out ? "Timed out" : "Failed"}
									</Chip>
								</td>
								<td>{c.exit_code ?? "—"}</td>
								<td>{(c.duration_ms / 1000).toFixed(1)} s</td>
								<td>{c.log_truncated ? "truncated capture" : "complete"}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			<p className="wsm1-note">
				Checks are listed per verification command; which criteria each one
				covers is shown above.
			</p>
			<h4>Review</h4>
			<dl className="wsm1-kvs">
				<KV label="Verdict">
					<Chip tone={env.review.verdict === "approve" ? "ok" : "bad"}>
						{env.review.verdict ?? "none"}
					</Chip>{" "}
					{env.review.valid ? "valid" : "not valid"}
				</KV>
				<KV label="Findings">
					{env.review.findings} total, {env.review.blocking_findings} blocking
				</KV>
				<KV label="Bound to">
					candidate {shortHash(env.review.candidate_sha)} · manifest{" "}
					{shortHash(env.review.manifest_hash)}
				</KV>
			</dl>
			<p className="wsm1-note">{ACCEPTANCE_SCOPE_NOTE}</p>
		</div>
	);
}

/** Region "Evidence": overall status + every artifact (opens the viewer). */
export function EvidenceList({ detail }: { detail: WorkspaceTaskDetail }) {
	const { store, state } = useWs();
	const overall = evidenceStatus(detail);
	const history = acceptedHistory(detail);
	// UI freshness policy: an accepted result's stale `valid` reading never shows as green verified
	const staleValid =
		history === null &&
		acceptedResultRequest(detail) !== null &&
		freshnessOf(detail.acceptance_validity, state.conn)?.stale === true;
	const byRun = new Map<string, ArtifactListItem[]>();
	for (const a of detail.artifacts)
		byRun.set(a.run_id, [...(byRun.get(a.run_id) ?? []), a]);
	return (
		<section aria-label="Evidence" className="wsm1-block">
			<h3>Evidence</h3>
			<p>
				Result evidence:{" "}
				<Chip
					tone={
						staleValid
							? "waiting"
							: history === null
								? toneOf(overall)
								: history === "invalid"
									? "bad"
									: "waiting"
					}
					testId="evidence-status"
					data={{ status: overall }}
				>
					{staleValid
						? ACCEPTED_STALE_EVIDENCE_LABEL
						: evidenceStatusLabel(detail)}
				</Chip>
				{state.source === "fixture" ? (
					<span className="wsm1-note"> UI fixture: synthetic evidence.</span>
				) : null}
			</p>
			{detail.artifacts.length === 0 ? (
				<p className="wsm1-muted">No evidence has been recorded yet.</p>
			) : (
				[...byRun.entries()].map(([runId, items]) => {
					const run = detail.runs.find((r) => r.run_id === runId);
					return (
						<div key={runId} className="wsm1-evgroup">
							<h4>
								Attempt {run?.attempt_no ?? "?"}
								{run?.candidate_sha
									? ` · candidate ${shortHash(run.candidate_sha)}`
									: ""}
							</h4>
							<ul className="wsm1-evlist">
								{items.map((a) => {
									const env = envelopeItem(detail, a);
									const status = env?.status ?? null;
									const req = detail.approval_requests.find(
										(r) => r.kind === "result" && r.run_id === a.run_id,
									);
									const revoked = resultRevocation(
										req ?? {
											kind: "run",
											status: "pending",
											invalidation_reason: null,
										},
									);
									const acceptedOriginal =
										history !== null && req?.status === "accepted";
									return (
										<li key={a.artifact_id}>
											<button
												type="button"
												id={artifactDomId(a.artifact_id)}
												className="wsm1-link"
												onClick={() =>
													void store.openArtifact(
														detail.task.id,
														a,
														artifactDomId(a.artifact_id),
													)
												}
											>
												{a.name}
											</button>
											<span className="wsm1-muted">
												{a.kind.replaceAll("_", " ")} · {a.byte_len} bytes
												{a.truncated ? " · truncated" : ""}
											</span>
											{revoked ? (
												<Chip tone="neutral">
													Sealed status void · open to re-check
												</Chip>
											) : acceptedOriginal && status ? (
												<Chip tone="neutral">
													Accepted original · {EVIDENCE_LABEL[status]} when
													sealed
												</Chip>
											) : status ? (
												<Chip tone={toneOf(status)}>
													{EVIDENCE_LABEL[status]}
												</Chip>
											) : (
												<Chip tone="neutral">Not in a sealed result</Chip>
											)}
										</li>
									);
								})}
							</ul>
						</div>
					);
				})
			)}
		</section>
	);
}

const NO_CONTENT: Record<string, string> = {
	missing: "No content: this item is missing.",
	corrupt: "No content: the stored bytes do not match their record.",
	stale: "No content: this item is bound to another candidate.",
	unknown: "No content: the status could not be determined.",
};

/** The modal evidence dialog. Escape closes it; the shell returns focus to the opener. */
export function EvidenceViewer({ viewer }: { viewer: ViewerState }) {
	const { store, state } = useWs();
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const d = ref.current;
		if (d && !d.open) d.showModal();
	}, []);
	const detail = state.details[viewer.taskId]?.data ?? null;
	const item = detail?.artifacts.find(
		(a) => a.artifact_id === viewer.artifactId,
	);
	const run = item
		? detail?.runs.find((r) => r.run_id === item.run_id)
		: undefined;
	const env = detail && item ? envelopeItem(detail, item) : null;
	// the hub serves a sealed result's retained buffer with its SEALED status; once that result was
	// invalidated by revalidation, this is a historical copy, never current verification
	const resultReq = item
		? detail?.approval_requests.find(
				(r) => r.kind === "result" && r.run_id === item.run_id,
			)
		: undefined;
	const revoked = resultReq ? resultRevocation(resultReq) : null;
	// v1.2: an accepted result is served from its sealed copy; unless the hub says the acceptance is
	// valid NOW, that content is the accepted original (history), never current verification
	const acceptedOriginal =
		resultReq?.status === "accepted" && detail
			? acceptedHistory(detail) !== null
			: false;
	const data = viewer.data;
	const status = data?.status ?? null;
	const disclosed = status === "verified" || status === "truncated";
	const dataState =
		viewer.state === "loading"
			? "loading"
			: viewer.state === "error" ||
					(status !== null && !disclosed && status !== "withheld")
				? "error"
				: "ok";
	return (
		<dialog
			ref={ref}
			className="wsm1-viewer"
			aria-label={`Evidence: ${viewer.name}`}
			data-artifact-id={viewer.artifactId}
			data-state={dataState}
			data-history={acceptedOriginal ? "accepted-original" : undefined}
			onCancel={(e) => {
				e.preventDefault();
				store.closeArtifact();
			}}
		>
			<div className="wsm1-viewer-head">
				<h2>Evidence: {viewer.name}</h2>
				<dl className="wsm1-kvs">
					<KV label="Kind">{item?.kind.replaceAll("_", " ") ?? "—"}</KV>
					<KV label="Status">
						{status ? (
							<Chip tone={acceptedOriginal ? "neutral" : toneOf(status)}>
								{EVIDENCE_LABEL[status]}
								{acceptedOriginal ? " · accepted original (history)" : ""}
							</Chip>
						) : viewer.state === "loading" ? (
							"Loading…"
						) : (
							"—"
						)}
					</KV>
					<KV label="Attempt">
						{run ? `${run.attempt_no} (${run.run_id})` : "—"}
					</KV>
					<KV label="Candidate">
						{run?.candidate_sha ? (
							<Mono value={run.candidate_sha} />
						) : (
							"none recorded"
						)}
					</KV>
					<KV label="Size">{item ? `${item.byte_len} bytes` : "—"}</KV>
					<KV label="SHA-256">
						{env?.sha256 ? (
							<Mono value={env.sha256} />
						) : (
							"not in a sealed result"
						)}
					</KV>
				</dl>
				{state.source === "fixture" ? (
					<p className="wsm1-note">
						UI fixture: synthetic content, not produced by any execution.
					</p>
				) : null}
			</div>
			<div className="wsm1-viewer-body">
				{viewer.state === "loading" ? <p>Loading evidence…</p> : null}
				{viewer.state === "error" ? (
					<p className="wsm1-error-text">{viewer.error}</p>
				) : null}
				{acceptedOriginal ? (
					<p
						className="wsm1-banner wsm1-tone-waiting"
						data-testid="evidence-history"
					>
						{ACCEPTED_ORIGINAL_NOTE} Current validity of the acceptance:{" "}
						{validityShortLabel(detail?.acceptance_validity)}.
					</p>
				) : null}
				{revoked && resultReq?.invalidation_reason ? (
					<p className="wsm1-banner wsm1-tone-bad">
						The result this item belongs to was invalidated (
						{INVALIDATION_LABEL[resultReq.invalidation_reason]}), so it cannot
						be accepted. The status above is the hub's fresh check of the stored
						file.
					</p>
				) : null}
				{status === "truncated" ? (
					<p className="wsm1-banner wsm1-tone-waiting">
						Truncated capture: the stored log is incomplete; the check outcome
						is in the manifest.
					</p>
				) : null}
				{status === "withheld" ? (
					<p className="wsm1-banner wsm1-tone-waiting">
						Withheld: this content could not be disclosed safely and is not
						shown. Reason codes:{" "}
						{data?.withheld_reasons.join(", ") || "none given"}. Acceptance
						stays blocked while required evidence is withheld.
					</p>
				) : null}
				{status && NO_CONTENT[status] ? (
					<p className="wsm1-banner wsm1-tone-bad">{NO_CONTENT[status]}</p>
				) : null}
				{disclosed && data?.text !== null && data?.text !== undefined ? (
					// biome-ignore lint/a11y/noNoninteractiveTabindex: MATRIX §7 requires a keyboard-scrollable pre (tabindex=0)
					<pre className="wsm1-pre" tabIndex={0}>
						{data.text}
					</pre>
				) : null}
			</div>
			<div className="wsm1-viewer-foot">
				<button type="button" onClick={() => store.closeArtifact()}>
					Close evidence
				</button>
			</div>
		</dialog>
	);
}
