// Validity freshness — UI policy only (NOTES.md "Validity freshness"). Pins: the documented
// thresholds; `unknown` / `unverifiable` / stale never render as a green "verified"; the hub's status
// (`data-status`) and the historical decision are never rewritten; an invalid current validity keeps
// a non-dismissable alert in task detail, HQ and history (one announced alert per view); the
// coverage definition makes no semantic / real-provider claim.
import { describe, expect, test } from "bun:test";
import {
	type AcceptanceValidityStatus,
	type AcceptanceValidityView,
	type ApprovalRequestView,
	criteriaFromText,
	emptyDraft,
	WorkspaceTaskDetail,
} from "@agent-city/schema/workspace-m1";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EvidenceList } from "./Evidence.tsx";
import {
	createFixtureTransport,
	type FixtureTransport,
} from "./fixture-transport.ts";
import { HqView } from "./HqView.tsx";
import {
	ACCEPTED_STALE_EVIDENCE_LABEL,
	acceptanceValidityDisplay,
	CONNECTION_STALE_AFTER_MS,
	COVERAGE_SATISFIED_NOTE,
	VALIDITY_STALE_AFTER_MS,
	validityFreshness,
	validityShortLabel,
} from "./labels.ts";
import { CriteriaPlan, StoreContext } from "./parts.tsx";
import { WorkspaceStore, type WsState } from "./store.ts";
import { TaskPanel } from "./TaskPanel.tsx";
import type { TransportResult } from "./transport.ts";
import { AcceptanceValidityBlock, ValidityHistoryLine } from "./Validity.tsx";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const online = { status: "online", lastConfirmedAt: iso(NOW - 1_000) };

const view = (
	over: Partial<AcceptanceValidityView> = {},
): AcceptanceValidityView => ({
	decision_id: "wsd-00000000-0000-4000-8000-0000000000aa",
	status: "valid",
	reason: null,
	detail: null,
	checked_at: iso(NOW - 3_000),
	first_invalid_at: null,
	evidence_bundle_digest: "b0".repeat(32),
	...over,
});

const forStatus = (status: AcceptanceValidityStatus) =>
	view({
		status,
		reason:
			status === "valid"
				? null
				: status === "invalid"
					? "source_evidence_changed"
					: status === "unknown"
						? "verification_unavailable"
						: "legacy_no_durable_evidence",
		first_invalid_at: status === "invalid" ? iso(NOW - 3_000) : null,
		evidence_bundle_digest: status === "unverifiable" ? null : "b0".repeat(32),
	});

describe("thresholds (documented UI policy)", () => {
	test("a check is stale strictly after 60 s; a future stamp (clock skew) reads as just now", () => {
		expect(VALIDITY_STALE_AFTER_MS).toBe(60_000);
		expect(CONNECTION_STALE_AFTER_MS).toBe(10_000);
		const at = (age: number) => validityFreshness(iso(NOW - age), NOW, online);
		expect(at(0)).toMatchObject({ stale: false, cause: "fresh" });
		expect(at(60_000)).toMatchObject({ stale: false, cause: "fresh" });
		expect(at(60_001)).toMatchObject({ stale: true, cause: "old_check" });
		expect(at(-30_000)).toMatchObject({ stale: false, ageMs: 0 });
		expect(at(3_000).line).toBe("Last check 3 s ago (11:59:57 UTC).");
		expect(at(5 * 60_000).line).toBe(
			"Last check 5 min ago (11:55:00 UTC) — may be out of date.",
		);
		expect(validityFreshness("not a time", NOW, online).stale).toBe(true);
	});

	test("an offline / connecting / silent connection makes even a recent check stale", () => {
		const recent = iso(NOW - 1_000);
		for (const conn of [
			{ status: "offline", lastConfirmedAt: iso(NOW - 1_000) },
			{ status: "connecting", lastConfirmedAt: null },
			{ status: "online", lastConfirmedAt: null },
			{
				status: "online",
				lastConfirmedAt: iso(NOW - CONNECTION_STALE_AFTER_MS - 1),
			},
		]) {
			const f = validityFreshness(recent, NOW, conn);
			expect(f).toMatchObject({ stale: true, cause: "connection" });
			expect(f.line).toContain("may be out of date");
			expect(f.line).toContain("connection to the hub is offline or stale");
		}
		expect(
			validityFreshness(recent, NOW, {
				status: "online",
				lastConfirmedAt: iso(NOW - CONNECTION_STALE_AFTER_MS),
			}).stale,
		).toBe(false);
	});
});

describe("never a green 'verified' unless valid AND fresh; the hub's status is never rewritten", () => {
	const fresh = validityFreshness(iso(NOW - 3_000), NOW, online);
	const stale = validityFreshness(iso(NOW - 120_000), NOW, online);
	test("valid + stale → neutral, 'not confirmed as current', data-status still valid", () => {
		const d = acceptanceValidityDisplay(view(), null, stale);
		expect(d).toMatchObject({
			status: "valid",
			tone: "neutral",
			alert: false,
			freshness: "stale",
		});
		expect(d.text).not.toMatch(/verified/i);
		expect(d.text).toContain("may be out of date");
		expect(validityShortLabel(view(), stale)).toContain("may be out of date");
		expect(validityShortLabel(view(), stale)).not.toMatch(/verified/i);
	});

	test("every status × freshness: tone ok only for valid + fresh; only invalid is an alert", () => {
		for (const status of [
			"valid",
			"invalid",
			"unknown",
			"unverifiable",
		] as const)
			for (const f of [fresh, stale, null]) {
				const d = acceptanceValidityDisplay(forStatus(status), null, f);
				expect(d.status).toBe(status);
				expect(d.tone === "ok").toBe(status === "valid" && f?.stale !== true);
				expect(/^Current evidence verified/.test(d.text)).toBe(
					status === "valid" && f?.stale !== true,
				);
				expect(d.alert).toBe(status === "invalid");
			}
		// nothing reported: never verified, regardless of freshness
		expect(acceptanceValidityDisplay(null, null, fresh)).toMatchObject({
			status: "unknown",
			tone: "waiting",
			freshness: null,
		});
	});

	test("block render: freshness line next to the validity; stale invalid keeps its role=alert; no dismiss control", () => {
		const detail = {
			decisions: [],
			approval_requests: [],
			acceptance_validity: forStatus("invalid"),
		};
		const html = renderToStaticMarkup(
			createElement(AcceptanceValidityBlock, { detail, freshness: stale }),
		);
		expect(html).toContain('data-status="invalid"');
		expect(html).toContain('role="alert"');
		expect(html).toContain('data-freshness="stale"');
		expect(html).toContain('data-testid="validity-freshness"');
		expect(html).toContain("may be out of date");
		expect(html).not.toMatch(/<button/i);
		const ok = renderToStaticMarkup(
			createElement(AcceptanceValidityBlock, {
				detail: { ...detail, acceptance_validity: view() },
				freshness: fresh,
			}),
		);
		expect(ok).toContain('data-freshness="fresh"');
		expect(ok).toContain("wsm1-tone-ok");
		expect(ok).toContain("Last check 3 s ago");
		const old = renderToStaticMarkup(
			createElement(AcceptanceValidityBlock, {
				detail: { ...detail, acceptance_validity: view() },
				freshness: stale,
			}),
		);
		expect(old).toContain('data-status="valid"');
		expect(old).not.toContain("wsm1-tone-ok");
		expect(old).toContain("wsm1-tone-neutral");
	});

	test("history line: invalid is a visible warning, announced when asked; stale valid says so", () => {
		const announced = renderToStaticMarkup(
			createElement(ValidityHistoryLine, {
				validity: forStatus("invalid"),
				freshness: fresh,
				announce: true,
			}),
		);
		expect(announced).toContain('role="alert"');
		expect(announced).toContain("wsm1-history-invalid");
		expect(announced).toContain("no longer valid");
		const quiet = renderToStaticMarkup(
			createElement(ValidityHistoryLine, {
				validity: forStatus("invalid"),
				announce: false,
			}),
		);
		expect(quiet).not.toContain('role="alert"');
		expect(quiet).toContain("wsm1-history-invalid");
		const staleValid = renderToStaticMarkup(
			createElement(ValidityHistoryLine, {
				validity: view(),
				freshness: stale,
			}),
		);
		expect(staleValid).toContain('data-status="valid"');
		expect(staleValid).toContain('data-freshness="stale"');
		expect(staleValid).toContain("may be out of date");
	});
});

// ── integrated renders (fixture transport → store → components) ─────────────
// Components read this browser's clock (Date.now); the fixture clock is shifted to make a check old.

function must<T>(r: TransportResult<T>): T {
	if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
	return r.data;
}
let keyN = 0;
const key = () => `freshness-test-${++keyN}`;
const flush = async () => {
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

async function grant(
	tx: FixtureTransport,
	req: ApprovalRequestView,
	action: "approve" | "accept",
) {
	const ch = must(
		await tx.issueChallenge(req.id, {
			kind: req.kind,
			binding_hash: req.binding_hash,
			expected_request_rev: req.rev,
		}),
	);
	must(
		await tx.decide(
			req.id,
			JSON.stringify({
				idempotency_key: key(),
				kind: req.kind,
				action,
				expected_request_rev: ch.request_rev,
				binding_hash: req.binding_hash,
				confirmation_text: "Edward",
				reason: null,
				challenge: ch.challenge,
			}),
		),
	);
}

/** An accepted task through the public fixture routes; `ageMs` = how old the fixture clock is. */
async function accepted(ageMs = 0) {
	const tx = createFixtureTransport({ now: () => Date.now() - ageMs });
	const c = must(
		await tx.createTask({
			idempotency_key: key(),
			repo_id: "local/fixture",
			draft: {
				...emptyDraft(),
				title: "Freshness task",
				objective: "Exercise the validity freshness display.",
				criteria: criteriaFromText("Build passes"),
				scope: { allowed: ["."], protected: [] },
				criterion_checks: [{ criterion: "Build passes", checks: ["unit"] }],
			},
		}),
	);
	const p = must(
		await tx.publishProposal(c.task.id, { expected_rev: c.task.rev }),
	);
	const run = p.approval_requests.find((r) => r.kind === "run");
	if (!run) throw new Error("no run request");
	await grant(tx, run, "approve");
	tx.controls.runToEnd(c.task.id, "verified");
	const d = WorkspaceTaskDetail.parse(must(await tx.getTask(c.task.id)));
	const result = d.approval_requests.find((r) => r.kind === "result");
	if (!result) throw new Error("no result request");
	await grant(tx, result, "accept");
	const store = new WorkspaceStore({ transport: tx });
	await store.boot();
	return { tx, store, taskId: c.task.id, runId: run.id, resultId: result.id };
}

const renderWith = (
	store: WorkspaceStore,
	el: ReactElement,
	state: WsState = store.getState(),
) =>
	renderToStaticMarkup(
		createElement(StoreContext.Provider, { value: { store, state } }, el),
	);

const alerts = (html: string) => html.split('role="alert"').length - 1;

describe("integrated: task detail, HQ document, history", () => {
	test("fresh valid in task detail: green verified with the check time; evidence chip verified", async () => {
		const a = await accepted(0);
		a.store.navigate({
			view: "projects",
			repoId: "local/fixture",
			taskId: a.taskId,
			requestId: null,
		});
		await flush();
		const html = renderWith(a.store, createElement(TaskPanel));
		expect(html).toMatch(
			/data-testid="acceptance-validity"[^>]*data-status="valid"/,
		);
		expect(html).toContain('data-freshness="fresh"');
		expect(html).toContain("Current evidence verified");
		expect(html).not.toContain(ACCEPTED_STALE_EVIDENCE_LABEL);
	});

	test("a check older than the threshold: not green, 'may be out of date' in task detail, HQ and history; evidence chip not verified; data-status stays valid", async () => {
		const a = await accepted(VALIDITY_STALE_AFTER_MS + 30_000);
		a.store.navigate({
			view: "projects",
			repoId: "local/fixture",
			taskId: a.taskId,
			requestId: null,
		});
		await flush();
		const task = renderWith(a.store, createElement(TaskPanel));
		expect(task).toMatch(
			/data-testid="acceptance-validity"[^>]*data-status="valid"/,
		);
		expect(task).toContain('data-freshness="stale"');
		expect(task).toContain("may be out of date");
		expect(task).not.toContain("Current evidence verified");
		const d = a.store.detail(a.taskId);
		if (!d) throw new Error("no detail");
		const evidence = renderWith(
			a.store,
			createElement(EvidenceList, { detail: d }),
		);
		expect(evidence).toContain(ACCEPTED_STALE_EVIDENCE_LABEL);
		expect(evidence).not.toMatch(
			/wsm1-tone-ok[^>]*data-testid="evidence-status"/,
		);
		a.store.navigate({
			view: "hq",
			repoId: null,
			taskId: a.taskId,
			requestId: a.resultId,
		});
		await flush();
		const hq = renderWith(a.store, createElement(HqView));
		expect(hq).toContain('data-freshness="stale"');
		expect(hq).toMatch(
			/data-testid="history-acceptance-validity"[^>]*data-status="valid"[^>]*data-freshness="stale"/,
		);
		expect(hq).not.toContain("Current evidence verified");
		expect(hq).toContain(
			'data-testid="acceptance-status" data-status="accepted"',
		);
	});

	test("offline connection: a recent check still reads 'may be out of date' (connection), never green", async () => {
		const a = await accepted(0);
		a.store.navigate({
			view: "projects",
			repoId: "local/fixture",
			taskId: a.taskId,
			requestId: null,
		});
		await flush();
		const s = a.store.getState();
		const offline: WsState = {
			...s,
			conn: { ...s.conn, status: "offline" },
		};
		const html = renderWith(a.store, createElement(TaskPanel), offline);
		expect(html).toContain('data-cause="connection"');
		expect(html).toContain("connection to the hub is offline or stale");
		expect(html).not.toContain("Current evidence verified");
	});

	test("invalid: non-dismissable alert in task detail and HQ; exactly one announced alert per view (history announces when the document shows the run request)", async () => {
		const a = await accepted(0);
		expect(
			a.tx.controls.setAcceptanceValidity(
				a.taskId,
				"invalid",
				"source_evidence_changed",
			),
		).toBe(true);
		a.store.navigate({
			view: "projects",
			repoId: "local/fixture",
			taskId: a.taskId,
			requestId: null,
		});
		await flush();
		const task = renderWith(a.store, createElement(TaskPanel));
		expect(task).toMatch(
			/data-testid="acceptance-validity"[^>]*data-status="invalid"/,
		);
		expect(alerts(task)).toBe(1);
		// HQ on the accepted result: the document announces; history shows the warning quietly
		a.store.navigate({
			view: "hq",
			repoId: null,
			taskId: a.taskId,
			requestId: a.resultId,
		});
		await flush();
		const onResult = renderWith(a.store, createElement(HqView));
		expect(alerts(onResult)).toBe(1);
		expect(onResult).toMatch(
			/data-testid="acceptance-validity"[^>]*role="alert"/,
		);
		expect(onResult).toContain("wsm1-history-invalid");
		// HQ on the run request of the same task: the history line is the announced alert
		a.store.navigate({
			view: "hq",
			repoId: null,
			taskId: a.taskId,
			requestId: a.runId,
		});
		await flush();
		const onRun = renderWith(a.store, createElement(HqView));
		expect(alerts(onRun)).toBe(1);
		expect(onRun).toMatch(
			/data-testid="history-acceptance-validity"[^>]*data-status="invalid"[^>]*role="alert"/,
		);
		expect(onRun).not.toMatch(/<button[^>]*>Dismiss/);
	});

	test("history shows concise proposal version labels", async () => {
		const a = await accepted(0);
		a.store.navigate({
			view: "hq",
			repoId: null,
			taskId: a.taskId,
			requestId: a.resultId,
		});
		await flush();
		const hq = renderWith(a.store, createElement(HqView));
		expect(hq).toContain("execution · approve · Proposal v1");
		expect(hq).toMatch(/result · accept · result [0-9a-f]{12} · Proposal v1/);
	});
});

describe("coverage definition", () => {
	test("satisfied = mapped checks passed with sealed evidence under the simulated contract; no semantic / real-provider claim", () => {
		expect(COVERAGE_SATISFIED_NOTE).toContain(
			"the mapped checks passed with sealed evidence under the simulated contract",
		);
		expect(COVERAGE_SATISFIED_NOTE).toContain(
			"not proof that the requirement is met",
		);
		expect(COVERAGE_SATISFIED_NOTE).toContain("no real provider verified it");
	});

	test("the Gate-1 plan states it under the criterion → check table", async () => {
		const a = await accepted(0);
		const d =
			a.store.detail(a.taskId) ??
			WorkspaceTaskDetail.parse(must(await a.tx.getTask(a.taskId)));
		const snapshot = d.current_proposal?.snapshot;
		if (!snapshot) throw new Error("no proposal");
		const html = renderToStaticMarkup(
			createElement(CriteriaPlan, { snapshot }),
		);
		expect(html).toContain('data-testid="coverage-definition"');
		expect(html).toContain(COVERAGE_SATISFIED_NOTE);
	});
});
