// Per-criterion coverage of a sealed result (Gate-2 subject, task detail); the Gate-1 plan view
// (`CriteriaPlan`) lives in parts.tsx next to ProposalView. Contract delta v1.2 — CONTRACT_V1_2.md §A. Everything shown comes
// from the hub's proposal snapshot / sealed envelope; coverage is never inferred from a count of
// green checks, and a legacy (v1) proposal or result says it has no coverage instead of inventing it.
import {
	type AnyProposalSnapshot,
	type AnyResultEnvelope,
	type CriterionCoverage,
	isProposalV1_2,
	isResultV1_2,
	type WorkspaceTaskDetail,
} from "@agent-city/schema/workspace-m1";
import {
	CHECK_OUTCOME_LABEL,
	COVERAGE_SATISFIED_NOTE,
	CRITERION_STATUS_LABEL,
	LEGACY_COVERAGE_NOTE,
	NO_RESULT_COVERAGE_NOTE,
	PENDING_RESULT_COVERAGE_NOTE,
	shortHash,
	worstCriterionStatus,
} from "./labels.ts";
import { Chip, Mono } from "./parts.tsx";

const statusTone = (s: CriterionCoverage["status"]) =>
	s === "satisfied" ? "ok" : s === "unsatisfied" ? "bad" : "waiting";

/**
 * Per-criterion coverage of a sealed result (`[data-testid=criterion-coverage][data-status]`,
 * rows `[data-criterion-id][data-status]`). `proposal` (when it is the envelope's proposal) only
 * supplies the criterion text; the statuses are the envelope's own.
 */
export function CriterionCoverageView({
	envelope,
	proposal,
}: {
	envelope: AnyResultEnvelope;
	proposal: AnyProposalSnapshot | null;
}) {
	if (!isResultV1_2(envelope))
		return (
			<section
				aria-label="Criterion coverage"
				className="wsm1-block"
				data-testid="criterion-coverage"
				data-status="legacy"
			>
				<h4>Criterion coverage</h4>
				<p className="wsm1-banner wsm1-tone-waiting">{LEGACY_COVERAGE_NOTE}</p>
			</section>
		);
	const coverage = envelope.criterion_coverage;
	const texts = new Map<string, string>();
	if (
		proposal &&
		isProposalV1_2(proposal) &&
		proposal.proposal_id === envelope.proposal_id
	)
		for (const c of proposal.criteria) texts.set(c.id, c.text);
	const counts = {
		satisfied: coverage.filter((c) => c.status === "satisfied").length,
		unsatisfied: coverage.filter((c) => c.status === "unsatisfied").length,
		unresolved: coverage.filter((c) => c.status === "unresolved").length,
	};
	return (
		<section
			aria-label="Criterion coverage"
			className="wsm1-block"
			data-testid="criterion-coverage"
			data-status={worstCriterionStatus(coverage.map((c) => c.status))}
		>
			<h4>Criterion coverage</h4>
			<p className="wsm1-note">
				{counts.satisfied} of {coverage.length} criteria satisfied
				{counts.unsatisfied ? ` · ${counts.unsatisfied} not satisfied` : ""}
				{counts.unresolved ? ` · ${counts.unresolved} unresolved` : ""}.{" "}
				{COVERAGE_SATISFIED_NOTE}
			</p>
			<table
				className="wsm1-table wsm1-coverage"
				aria-label="Criterion coverage"
			>
				<thead>
					<tr>
						<th scope="col">Criterion</th>
						<th scope="col">Status</th>
						<th scope="col">Mapped checks</th>
					</tr>
				</thead>
				<tbody>
					{coverage.map((c, i) => (
						<tr
							key={c.criterion_id}
							data-criterion-id={c.criterion_id}
							data-status={c.status}
						>
							<th scope="row">
								<span className="wsm1-wrap">
									{i + 1}. {texts.get(c.criterion_id) ?? "criterion"}
								</span>
								<br />
								<Mono value={c.criterion_id} />
							</th>
							<td>
								<Chip tone={statusTone(c.status)}>
									{CRITERION_STATUS_LABEL[c.status]}
								</Chip>
							</td>
							<td>
								<ul className="wsm1-coverage-checks">
									{c.checks.map((x) => (
										<li
											key={x.check}
											data-check={x.check}
											data-outcome={x.outcome}
											data-log={x.log_artifact_id ? "present" : "absent"}
										>
											<strong>{x.check}</strong>:{" "}
											{CHECK_OUTCOME_LABEL[x.outcome]}
											<span
												className="wsm1-coverage-log"
												title={
													x.log_artifact_id && x.log_sha256
														? `${x.log_artifact_id} · ${x.log_sha256}`
														: undefined
												}
											>
												{x.log_artifact_id && x.log_sha256 ? (
													<>
														log …{x.log_artifact_id.slice(-8)}
														<br />
														sha256 {shortHash(x.log_sha256)}
													</>
												) : (
													"no log evidence"
												)}
											</span>
										</li>
									))}
								</ul>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}

/**
 * Task-detail coverage: the latest result's coverage; without a sealed result, say so plainly
 * (`data-status=none`, or `legacy` for a v1 proposal) instead of implying anything is covered.
 */
export function TaskCoverage({
	detail,
}: {
	detail: Pick<
		WorkspaceTaskDetail,
		"approval_requests" | "current_proposal" | "engine" | "task"
	>;
}) {
	const proposal: AnyProposalSnapshot | null =
		detail.current_proposal?.snapshot ?? null;
	const result = detail.approval_requests.find(
		(r) => r.kind === "result" && r.result_envelope,
	);
	const envelope: AnyResultEnvelope | null = result?.result_envelope ?? null;
	if (envelope)
		return <CriterionCoverageView envelope={envelope} proposal={proposal} />;
	if (!detail.engine || !proposal) return null;
	const legacy = !isProposalV1_2(proposal);
	const ended =
		detail.task.stage === "execution_ended" ||
		detail.task.stage === "cancelled";
	return (
		<section
			aria-label="Criterion coverage"
			className="wsm1-block"
			data-testid="criterion-coverage"
			data-status={legacy ? "legacy" : "none"}
		>
			<h4>Criterion coverage</h4>
			<p className="wsm1-note">
				{legacy
					? LEGACY_COVERAGE_NOTE
					: ended
						? NO_RESULT_COVERAGE_NOTE
						: PENDING_RESULT_COVERAGE_NOTE}
			</p>
		</section>
	);
}
