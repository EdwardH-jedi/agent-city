// Small shared presentational pieces of the workspace (role 07).
import {
	type AnyProposalSnapshot,
	isProposalV1_2,
	type ManagedProposalRow,
	proposalCriteriaTexts,
	type WorkspaceSnapshot,
} from "@agent-city/schema/workspace-m1";
import { createContext, type ReactNode, useContext } from "react";
import {
	COVERAGE_SATISFIED_NOTE,
	LEGACY_PROPOSAL_NOTE,
	SIMULATION_NOTE,
	type Tone,
} from "./labels.ts";
import type { WorkspaceStore, WsState } from "./store.ts";

export interface WorkspaceCtx {
	store: WorkspaceStore;
	state: WsState;
}

export const StoreContext = createContext<WorkspaceCtx | null>(null);

export function useWs(): WorkspaceCtx {
	const ctx = useContext(StoreContext);
	if (!ctx) throw new Error("workspace context missing");
	return ctx;
}

export const PANEL_TITLE_ID = "wsm1-panel-title";
export const DECISION_STATUS_ID = "wsm1-decision-status";

export function focusById(id: string): void {
	const el = document.getElementById(id);
	if (el) el.focus();
}

export function Chip({
	tone,
	children,
	testId,
	data,
}: {
	tone: Tone;
	children: ReactNode;
	testId?: string;
	data?: Record<string, string>;
}) {
	const attrs: Record<string, string> = {};
	for (const [k, v] of Object.entries(data ?? {})) attrs[`data-${k}`] = v;
	return (
		<span
			className={`wsm1-chip wsm1-tone-${tone}`}
			data-testid={testId}
			{...attrs}
		>
			{children}
		</span>
	);
}

/** A full identity value (hash / sha / id), wrapping, never truncated in the DOM. */
export function Mono({ value, testId }: { value: string; testId?: string }) {
	return (
		<code className="wsm1-mono" data-testid={testId}>
			{value}
		</code>
	);
}

export function KV({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="wsm1-kv">
			<dt>{label}</dt>
			<dd>{children}</dd>
		</div>
	);
}

/** Provenance repeated on each task / approval / result (SOL §D, three independent labels). */
export function ProvenanceChips({
	snapshot,
	source,
}: {
	snapshot: WorkspaceSnapshot | null;
	source: "hub" | "fixture";
}) {
	const data = snapshot?.provenance.data_source ?? source;
	return (
		<span className="wsm1-prov-inline">
			<Chip tone={data === "fixture" ? "waiting" : "neutral"}>
				{data === "fixture" ? "UI fixture" : "Hub record"}
			</Chip>
			<Chip tone="neutral">Simulated</Chip>
			<Chip tone="neutral">Integration unverified</Chip>
		</span>
	);
}

/** The immutable proposal snapshot, exactly as Gate 1 authorizes it. */
export function ProposalView({
	proposal,
	heading,
}: {
	proposal: ManagedProposalRow;
	heading: string;
}) {
	// v1 | v1.2 (CONTRACT_V1_2.md §A): widen at the boundary so both row versions render
	const s: AnyProposalSnapshot = proposal.snapshot;
	return (
		<section aria-label="Proposal" className="wsm1-block">
			<h3>{heading}</h3>
			<dl className="wsm1-kvs">
				<KV label="Title">
					<span className="wsm1-wrap">{s.title}</span>
				</KV>
				<KV label="Version">
					v{s.version}
					{s.predecessor_proposal_id ? " (replaces an earlier version)" : ""}
				</KV>
			</dl>
			<h4>Objective</h4>
			<p className="wsm1-prose">{s.objective}</p>
			<h4>Acceptance criteria</h4>
			<ol aria-label="Acceptance criteria" className="wsm1-criteria">
				{proposalCriteriaTexts(s).map((c, i) => (
					// positional, immutable list (v1 has no ids; v1.2 texts are byte-identical)
					// biome-ignore lint/suspicious/noArrayIndexKey: positional, immutable list
					<li key={i}>{c}</li>
				))}
			</ol>
			<CriteriaPlan snapshot={s} />
			<h4>Scope and base</h4>
			<dl className="wsm1-kvs">
				<KV label="Allowed paths">
					<span className="wsm1-wrap">{s.scope.allowed.join(", ")}</span>
				</KV>
				<KV label="Protected paths">
					<span className="wsm1-wrap">
						{s.scope.protected.length ? s.scope.protected.join(", ") : "none"}
					</span>
				</KV>
				<KV label="Repository">{s.repo_id}</KV>
				<KV label="Base">
					{s.base_ref} · <Mono value={s.base_sha} />
				</KV>
			</dl>
			<h4>Execution plan</h4>
			<dl className="wsm1-kvs">
				<KV label="Checks">{s.verification_plan.required_checks.join(", ")}</KV>
				<KV label="Providers">
					{s.provider_profiles.implementer.profile_id} ·{" "}
					{s.provider_profiles.reviewer.profile_id} (fake, simulated)
				</KV>
				<KV label="Repair allowance">
					{s.repair_policy.max_repairs === 0
						? "0 (no automatic repair)"
						: "1 pre-approved repair attempt"}
				</KV>
				<KV label="Limits">
					{s.budgets.max_attempts} attempt(s), {s.budgets.max_model_invocations}{" "}
					simulated provider calls at most
				</KV>
				<KV label="Simulation scenario">{s.simulation_scenario}</KV>
				<KV label="Context">Repository snapshot at the base commit only</KV>
			</dl>
			<p className="wsm1-note">
				{SIMULATION_NOTE} No network or host isolation is claimed.
			</p>
			<dl className="wsm1-kvs wsm1-ids">
				<KV label="Proposal hash">
					<Mono value={proposal.proposal_hash} />
				</KV>
			</dl>
		</section>
	);
}

/**
 * Gate-1 view of the plan: each criterion's stable id and the trusted checks that must pass for it
 * (`[data-testid=criteria-plan]`, rows `[data-criterion-id][data-checks]`). The criteria TEXT stays
 * in the `Acceptance criteria` list (unchanged); this table adds identity and mapping only.
 */
export function CriteriaPlan({ snapshot }: { snapshot: AnyProposalSnapshot }) {
	if (!isProposalV1_2(snapshot))
		return (
			<p
				className="wsm1-banner wsm1-tone-waiting"
				data-testid="criteria-plan"
				data-status="legacy"
			>
				{LEGACY_PROPOSAL_NOTE}
			</p>
		);
	const checksOf = new Map(
		snapshot.coverage_plan.map((p) => [p.criterion_id, p.checks]),
	);
	return (
		<>
			<table
				className="wsm1-table"
				aria-label="Criterion checks"
				data-testid="criteria-plan"
				data-status="mapped"
			>
				<thead>
					<tr>
						<th scope="col">Criterion</th>
						<th scope="col">Id</th>
						<th scope="col">Must pass (with log evidence)</th>
					</tr>
				</thead>
				<tbody>
					{snapshot.criteria.map((c, i) => {
						const checks = checksOf.get(c.id) ?? [];
						return (
							<tr
								key={c.id}
								data-criterion-id={c.id}
								data-checks={checks.join(" ")}
							>
								<th scope="row">{i + 1}</th>
								<td>
									<Mono value={c.id} />
								</td>
								<td>{checks.length ? checks.join(", ") : "none"}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
			<p className="wsm1-note" data-testid="coverage-definition">
				{COVERAGE_SATISFIED_NOTE}
			</p>
		</>
	);
}
