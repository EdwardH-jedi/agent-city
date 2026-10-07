// Current acceptance validity (role 07, contract delta v1.2 §C — CONTRACT_V1_2.md). Pins: display and
// wording rules, accepted-history evidence labels, the fixture's four states (hub rules, contract-
// valid answers), the store's validity merge (no stale "verified" after a poll said invalid; the
// display follows the hub), and the copy audit of every new string.
import { describe, expect, test } from "bun:test";
import {
	type AcceptanceValidityView,
	type ApprovalRequestView,
	ArtifactTextResponse,
	criteriaFromText,
	emptyDraft,
	WorkspaceSnapshot,
	WorkspaceTaskDetail,
} from "@agent-city/schema/workspace-m1";
import {
	createFixtureTransport,
	type FixtureTransport,
} from "./fixture-transport.ts";
import {
	ACCEPTED_HISTORY_EVIDENCE_LABEL,
	acceptanceValidityDisplay,
	acceptedHistory,
	allStaticCopy,
	EVIDENCE_LABEL,
	evidenceStatus,
	evidenceStatusLabel,
	VALIDITY_REASON_LABEL,
	validityShortLabel,
} from "./labels.ts";
import {
	mergeSnapshot,
	newerValidity,
	newestListItem,
	WorkspaceStore,
} from "./store.ts";
import type { TransportResult, WorkspaceTransport } from "./transport.ts";
import { acceptedAtOf } from "./Validity.tsx";

const BANNED =
	/\b(merg(e|ed|es|ing)|push(ed|es|ing)?|deploy(ed|s|ing|ment)?)\b/i;
const T0 = Date.parse("2026-10-02T00:00:00.000Z");
const DECISION = "wsd-00000000-0000-4000-8000-0000000000aa";

const view = (
	over: Partial<AcceptanceValidityView> = {},
): AcceptanceValidityView => ({
	decision_id: DECISION,
	status: "valid",
	reason: null,
	detail: null,
	checked_at: "2026-10-02T00:10:00.000Z",
	first_invalid_at: null,
	evidence_bundle_digest: "b0".repeat(32),
	...over,
});

function must<T>(r: TransportResult<T>): T {
	if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
	return r.data;
}

let keyN = 0;
const key = () => `validity-test-${++keyN}`;

function pendingOf(
	d: { approval_requests: ApprovalRequestView[] },
	kind: "run" | "result",
) {
	const r = d.approval_requests.find(
		(x) => x.kind === kind && x.status === "pending",
	);
	if (!r) throw new Error(`no pending ${kind} request`);
	return r;
}

async function decide(
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
	return must(
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

/** create → publish → Gate 1 → run → Gate 2 accept, through the public fixture routes. */
async function acceptedTask(tx: FixtureTransport, title = "Accepted task") {
	const c = must(
		await tx.createTask({
			idempotency_key: key(),
			repo_id: "local/fixture",
			draft: {
				...emptyDraft(),
				title,
				objective: "Exercise the current acceptance validity.",
				criteria: criteriaFromText("Build passes\nDocs updated"),
				scope: { allowed: ["."], protected: [] },
				criterion_checks: [
					{ criterion: "Build passes", checks: ["unit"] },
					{ criterion: "Docs updated", checks: ["lint"] },
				],
			},
		}),
	);
	const p = must(
		await tx.publishProposal(c.task.id, { expected_rev: c.task.rev }),
	);
	await decide(tx, pendingOf(p, "run"), "approve");
	tx.controls.runToEnd(c.task.id, "verified");
	const d = must(await tx.getTask(c.task.id));
	await decide(tx, pendingOf(d, "result"), "accept");
	return c.task.id;
}

const fixture = () => {
	let t = T0;
	const tx = createFixtureTransport({ now: () => t });
	return {
		tx,
		tick: (ms: number) => {
			t += ms;
		},
	};
};

describe("display rules (CONTRACT_V1_2 §C wording)", () => {
	const at = "2026-10-02T09:30:00.000Z";
	test("valid → 'current evidence verified (checked …)', no alert", () => {
		const d = acceptanceValidityDisplay(view(), at);
		expect(d).toMatchObject({ status: "valid", tone: "ok", alert: false });
		expect(d.text).toBe("Current evidence verified (checked 00:10:00 UTC).");
	});
	test("invalid → role=alert 'Accepted on …, but this result is no longer valid: <reason>'", () => {
		const d = acceptanceValidityDisplay(
			view({
				status: "invalid",
				reason: "source_evidence_changed",
				detail: "Stored evidence diff.patch changed after acceptance.",
				first_invalid_at: "2026-10-02T00:10:00.000Z",
			}),
			at,
		);
		expect(d).toMatchObject({
			status: "invalid",
			reason: "source_evidence_changed",
			tone: "bad",
			alert: true,
		});
		expect(d.text).toBe(
			"Accepted on 2026-10-02 09:30 UTC, but this result is no longer valid: a stored evidence file changed after acceptance.",
		);
		expect(d.note).toContain("diff.patch changed after acceptance");
		expect(d.note).toContain("cannot be restored");
	});
	test("unknown → 'verification unavailable', not an alert, never verified", () => {
		const d = acceptanceValidityDisplay(
			view({ status: "unknown", reason: "verification_unavailable" }),
			at,
		);
		expect(d).toMatchObject({ status: "unknown", alert: false });
		expect(d.tone).not.toBe("ok");
		expect(d.text).toMatch(/^Verification unavailable/);
	});
	test("unverifiable → 'legacy acceptance — no durable evidence'", () => {
		const d = acceptanceValidityDisplay(
			view({
				status: "unverifiable",
				reason: "legacy_no_durable_evidence",
				evidence_bundle_digest: null,
			}),
			at,
		);
		expect(d).toMatchObject({ status: "unverifiable", alert: false });
		expect(d.text).toMatch(/^Legacy acceptance — no durable evidence/);
	});
	test("nothing reported for an accepted result → unknown/not_reported, never verified, not an alert", () => {
		for (const v of [null, undefined]) {
			const d = acceptanceValidityDisplay(v, at);
			expect(d).toMatchObject({
				status: "unknown",
				reason: "not_reported",
				alert: false,
			});
			expect(d.tone).not.toBe("ok");
		}
	});
	test("only `valid` ever reads as verified; only `invalid` is an alert", () => {
		for (const status of [
			"valid",
			"invalid",
			"unknown",
			"unverifiable",
		] as const)
			for (const reason of Object.keys(VALIDITY_REASON_LABEL)) {
				const d = acceptanceValidityDisplay(
					view({
						status,
						reason:
							status === "valid"
								? null
								: (reason as AcceptanceValidityView["reason"]),
						first_invalid_at: status === "invalid" ? at : null,
					}),
					at,
				);
				expect(d.status).toBe(status);
				expect(d.alert).toBe(status === "invalid");
				expect(d.tone === "ok").toBe(status === "valid");
				expect(d.text.startsWith("Current evidence verified")).toBe(
					status === "valid",
				);
			}
	});
	test("accepted-at comes from the decision named by the validity (history timestamp)", () => {
		const d = {
			approval_requests: [] as ApprovalRequestView[],
			decisions: [
				{
					id: DECISION,
					approval_request_id: "wsa-00000000-0000-4000-8000-000000000001",
					kind: "result" as const,
					action: "accept" as const,
					operator_id: "operator:edward" as const,
					payload_hash: "f1".repeat(32),
					binding_hash: "f2".repeat(32),
					reason: null,
					result_envelope_hash: "f3".repeat(32),
					decided_at: at,
				},
			],
		};
		expect(acceptedAtOf(d, view())).toBe(at);
		expect(acceptedAtOf(d, null)).toBeNull();
	});
});

describe("accepted evidence is history unless the hub says valid", () => {
	test("evidence-status / item labels follow the current validity", async () => {
		const { tx } = fixture();
		const id = await acceptedTask(tx);
		const d = WorkspaceTaskDetail.parse(must(await tx.getTask(id)));
		expect(d.acceptance_validity?.status).toBe("valid");
		expect(acceptedHistory(d)).toBeNull();
		expect(evidenceStatus(d)).toBe("verified");
		expect(evidenceStatusLabel(d)).toBe(EVIDENCE_LABEL.verified);
		for (const [status, history] of [
			["invalid", "invalid"],
			["unknown", "unknown"],
			["unverifiable", "unverifiable"],
		] as const) {
			const v = {
				...d,
				acceptance_validity: view({
					status,
					reason: "bundle_corrupt",
					first_invalid_at: status === "invalid" ? view().checked_at : null,
				}),
			};
			expect(acceptedHistory(v)).toBe(history);
			expect(evidenceStatus(v)).toBe("unknown");
			expect(evidenceStatusLabel(v)).toBe(
				ACCEPTED_HISTORY_EVIDENCE_LABEL[history],
			);
		}
		const silent = { ...d, acceptance_validity: undefined };
		expect(acceptedHistory(silent)).toBe("not_reported");
		expect(evidenceStatus(silent)).toBe("unknown");
	});
	test("a pending (not accepted) result is unaffected by validity", async () => {
		const { tx } = fixture();
		const c = must(
			await tx.createTask({
				idempotency_key: key(),
				repo_id: "local/fixture",
				draft: {
					...emptyDraft(),
					title: "Pending result",
					objective: "o",
					criteria: ["c"],
					scope: { allowed: ["."], protected: [] },
					criterion_checks: [{ criterion: "c", checks: ["unit"] }],
				},
			}),
		);
		const p = must(
			await tx.publishProposal(c.task.id, { expected_rev: c.task.rev }),
		);
		await decide(tx, pendingOf(p, "run"), "approve");
		tx.controls.runToEnd(c.task.id, "verified");
		const d = WorkspaceTaskDetail.parse(must(await tx.getTask(c.task.id)));
		expect(d.acceptance_validity).toBeNull();
		expect(acceptedHistory(d)).toBeNull();
		expect(evidenceStatus(d)).toBe("verified");
	});
});

describe("fixture world: the four validity states (hub rules, contract-valid answers)", () => {
	test("accept → valid on the detail and on the snapshot list item", async () => {
		const { tx } = fixture();
		const id = await acceptedTask(tx);
		const d = WorkspaceTaskDetail.parse(must(await tx.getTask(id)));
		expect(d.task.stage).toBe("accepted");
		expect(d.acceptance_validity).toMatchObject({
			decision_id: d.task.accepted_decision_id,
			status: "valid",
			reason: null,
			first_invalid_at: null,
		});
		const snap = WorkspaceSnapshot.parse(must(await tx.getSnapshot()));
		const item = snap.tasks.find((x) => x.task.id === id);
		expect(item?.acceptance_validity?.status).toBe("valid");
	});

	test("corrupting a source artifact after acceptance → invalid on the next detail read; sticky; original still served", async () => {
		const { tx, tick } = fixture();
		const id = await acceptedTask(tx);
		const before = WorkspaceTaskDetail.parse(must(await tx.getTask(id)));
		const diff = before.artifacts.find((a) => a.name === "diff.patch");
		if (!diff) throw new Error("no diff");
		const original = ArtifactTextResponse.parse(
			must(await tx.getArtifact(id, diff.artifact_id)),
		);
		expect(tx.controls.corruptEvidence(id, "diff.patch")).toBe(true);
		// snapshot shows the stored row until a detail read re-checks
		let snap = WorkspaceSnapshot.parse(must(await tx.getSnapshot()));
		expect(
			snap.tasks.find((x) => x.task.id === id)?.acceptance_validity?.status,
		).toBe("valid");
		tick(1000);
		const after = WorkspaceTaskDetail.parse(must(await tx.getTask(id)));
		expect(after.task.stage).toBe("accepted"); // history unchanged
		expect(
			after.approval_requests.find((r) => r.kind === "result")?.status,
		).toBe("accepted");
		expect(after.acceptance_validity).toMatchObject({
			status: "invalid",
			reason: "source_evidence_changed",
			first_invalid_at: new Date(T0 + 1000).toISOString(),
		});
		snap = WorkspaceSnapshot.parse(must(await tx.getSnapshot()));
		expect(
			snap.tasks.find((x) => x.task.id === id)?.acceptance_validity?.status,
		).toBe("invalid");
		// sticky: no control and no later read restores valid
		expect(tx.controls.setAcceptanceValidity(id, "valid")).toBe(false);
		tick(1000);
		const later = WorkspaceTaskDetail.parse(must(await tx.getTask(id)));
		expect(later.acceptance_validity?.status).toBe("invalid");
		expect(later.acceptance_validity?.first_invalid_at).toBe(
			after.acceptance_validity?.first_invalid_at as string,
		);
		// the accepted original is still served from the sealed copy, as sealed
		const served = ArtifactTextResponse.parse(
			must(await tx.getArtifact(id, diff.artifact_id)),
		);
		expect(served.status).toBe("verified");
		expect(served.text).toBe(original.text);
		expect(served.text).not.toBeNull();
	});

	test("unknown (check cannot run) is not sticky; unverifiable is", async () => {
		const { tx } = fixture();
		const id = await acceptedTask(tx);
		expect(tx.controls.setAcceptanceValidity(id, "unknown")).toBe(true);
		let d = WorkspaceTaskDetail.parse(must(await tx.getTask(id)));
		expect(d.acceptance_validity).toMatchObject({
			status: "unknown",
			reason: "verification_unavailable",
		});
		d = WorkspaceTaskDetail.parse(must(await tx.getTask(id)));
		expect(d.acceptance_validity?.status).toBe("unknown"); // re-checks keep failing
		expect(tx.controls.setAcceptanceValidity(id, "valid")).toBe(true);
		d = WorkspaceTaskDetail.parse(must(await tx.getTask(id)));
		expect(d.acceptance_validity?.status).toBe("valid");
		expect(tx.controls.setAcceptanceValidity(id, "unverifiable")).toBe(true);
		d = WorkspaceTaskDetail.parse(must(await tx.getTask(id)));
		expect(d.acceptance_validity).toMatchObject({
			status: "unverifiable",
			reason: "legacy_no_durable_evidence",
			evidence_bundle_digest: null,
		});
		expect(tx.controls.setAcceptanceValidity(id, "valid")).toBe(false);
		expect(tx.controls.setAcceptanceValidity(id, "invalid")).toBe(false);
	});

	test("a broken sealed copy → invalid(bundle_*) and the artifact route discloses nothing", async () => {
		const { tx } = fixture();
		const id = await acceptedTask(tx);
		expect(
			tx.controls.setAcceptanceValidity(id, "invalid", "bundle_corrupt"),
		).toBe(true);
		const d = WorkspaceTaskDetail.parse(must(await tx.getTask(id)));
		expect(d.acceptance_validity?.reason).toBe("bundle_corrupt");
		for (const a of d.artifacts) {
			const r = ArtifactTextResponse.parse(
				must(await tx.getArtifact(id, a.artifact_id)),
			);
			expect(r.status).toBe("corrupt");
			expect(r.text).toBeNull();
		}
	});

	test("no validity before acceptance; the control refuses a task without an acceptance", async () => {
		const { tx } = fixture();
		const c = must(
			await tx.createTask({
				idempotency_key: key(),
				repo_id: "local/fixture",
				draft: { ...emptyDraft(), title: "Draft only" },
			}),
		);
		const d = WorkspaceTaskDetail.parse(must(await tx.getTask(c.task.id)));
		expect(d.acceptance_validity).toBeNull();
		expect(tx.controls.setAcceptanceValidity(c.task.id, "invalid")).toBe(false);
	});
});

describe("T0-SAME-P2-01 — an equal check never replaces a known sticky verdict", () => {
	const T = "2026-10-02T00:10:00.000Z";
	const BEFORE = "2026-10-02T00:09:59.999Z";
	const AFTER = "2026-10-02T00:10:00.001Z";
	const valid = view({ checked_at: T });
	const invalid = view({
		status: "invalid",
		reason: "bundle_missing",
		checked_at: T,
		first_invalid_at: T,
	});
	const unverifiable = view({
		status: "unverifiable",
		reason: "legacy_no_durable_evidence",
		checked_at: T,
	});
	const unknown = view({ status: "unknown", checked_at: T });

	test("A: current invalid @T, incoming valid @T → invalid", () => {
		expect(newerValidity(invalid, valid)).toBe(invalid);
	});
	test("B: current unverifiable @T, incoming valid @T → unverifiable", () => {
		expect(newerValidity(unverifiable, valid)).toBe(unverifiable);
		expect(newerValidity(unverifiable, unknown)).toBe(unverifiable);
	});
	test("C: current valid / unknown @T, incoming sticky @T → the sticky incoming", () => {
		expect(newerValidity(valid, invalid)).toBe(invalid);
		expect(newerValidity(valid, unverifiable)).toBe(unverifiable);
		expect(newerValidity(unknown, invalid)).toBe(invalid);
		expect(newerValidity(invalid, unknown)).toBe(invalid);
	});
	test("D: an older incoming never wins", () => {
		expect(newerValidity(invalid, view({ checked_at: BEFORE }))).toBe(invalid);
		const olderInvalid = view({ ...invalid, checked_at: BEFORE });
		expect(newerValidity(valid, olderInvalid)).toBe(valid);
	});
	test("E: a newer incoming wins (unchanged)", () => {
		const newerValid = view({ checked_at: AFTER });
		expect(newerValidity(invalid, newerValid)).toBe(newerValid);
		const newerInvalid = view({ ...invalid, checked_at: AFTER });
		expect(newerValidity(valid, newerInvalid)).toBe(newerInvalid);
	});
	test("F: equal check, neither sticky → incoming (the existing tie rule)", () => {
		const again = view({ checked_at: T });
		expect(newerValidity(valid, again)).toBe(again);
		expect(newerValidity(valid, unknown)).toBe(unknown);
		expect(newerValidity(unknown, valid)).toBe(valid);
	});
	test("equal check, both sticky → the known verdict (deterministic; sticky rows never change)", () => {
		expect(newerValidity(invalid, view({ ...invalid }))).toBe(invalid);
		expect(newerValidity(unverifiable, invalid)).toBe(unverifiable);
		expect(newerValidity(invalid, unverifiable)).toBe(invalid);
	});
	test("another decision or a missing value still follows the hub", () => {
		const other = view({
			decision_id: "wsd-00000000-0000-4000-8000-0000000000cc",
			checked_at: T,
		});
		expect(newerValidity(invalid, other)).toBe(other);
		expect(newerValidity(invalid, null)).toBeNull();
		expect(newerValidity(invalid, undefined)).toBe(invalid);
	});
	test("folding many reads (history settlement): a sticky verdict wins an equal check whichever row is newest by rev", () => {
		const row = (v: AcceptanceValidityView, rev: number) =>
			({
				task: { id: "wst-00000000-0000-4000-8000-0000000000aa", rev },
				phase: "accepted",
				acceptance_validity: v,
				engine: null,
				latest_request: null,
			}) as unknown as Parameters<typeof newestListItem>[0];
		// the delayed page row is the incoming one; the known detail / snapshot rows say invalid at the same instant
		expect(
			newestListItem(row(valid, 4), [undefined, row(invalid, 4)])
				.acceptance_validity,
		).toBe(invalid);
		expect(
			newestListItem(row(valid, 4), [row(invalid, 4), row(valid, 4)])
				.acceptance_validity?.status,
		).toBe("invalid");
		expect(
			newestListItem(row(invalid, 4), [row(valid, 4)]).acceptance_validity
				?.status,
		).toBe("invalid");
	});
});

describe("store: validity merge (one rule)", () => {
	test("newerValidity: newer check wins; undefined keeps; other decision / null follow the hub", () => {
		const valid = view({ checked_at: "2026-10-02T00:10:00.000Z" });
		const invalid = view({
			status: "invalid",
			reason: "source_evidence_changed",
			checked_at: "2026-10-02T00:11:00.000Z",
			first_invalid_at: "2026-10-02T00:11:00.000Z",
		});
		expect(newerValidity(valid, invalid)).toBe(invalid);
		expect(newerValidity(invalid, valid)).toBe(invalid); // older answer arrives late
		expect(newerValidity(invalid, undefined)).toBe(invalid);
		expect(newerValidity(undefined, valid)).toBe(valid);
		expect(newerValidity(null, valid)).toBe(valid);
		expect(newerValidity(valid, null)).toBeNull();
		const same = view({ ...invalid });
		// equal check, both sticky: the known verdict stays (T0-SAME-P2-01; a sticky row never changes)
		expect(newerValidity(invalid, same)).toBe(invalid);
		const other = view({
			decision_id: "wsd-00000000-0000-4000-8000-0000000000bb",
			checked_at: "2026-10-02T00:01:00.000Z",
		});
		expect(newerValidity(invalid, other)).toBe(other);
	});

	test("mergeSnapshot never puts an older 'valid' back over a newer 'invalid'", () => {
		const base = {
			provenance: {
				data_source: "fixture" as const,
				execution_mode: "simulated" as const,
				live_integration_verified: false as const,
			},
			repos: [],
			pending_requests: [],
			generated_at: "2026-10-02T00:00:00.000Z",
		};
		const task = {
			id: "wst-x",
			rev: 9,
		} as WorkspaceSnapshot["tasks"][number]["task"];
		const prev = {
			...base,
			tasks: [
				{
					task,
					phase: "accepted" as const,
					acceptance_validity: view({
						status: "invalid",
						reason: "candidate_mismatch",
						checked_at: "2026-10-02T00:11:00.000Z",
						first_invalid_at: "2026-10-02T00:11:00.000Z",
					}),
				},
			],
		};
		const staleNext = {
			...base,
			tasks: [
				{ task, phase: "accepted" as const, acceptance_validity: view() },
			],
		};
		const merged = mergeSnapshot(prev, staleNext);
		expect(merged.tasks[0]?.acceptance_validity?.status).toBe("invalid");
	});
});

/** Transport wrapper that can hold one method's answers (computed at call time, delivered later). */
function holdable(inner: WorkspaceTransport) {
	const holds = new Set<string>();
	const waiting: (() => void)[] = [];
	const t = { source: inner.source } as WorkspaceTransport;
	for (const name of Object.keys(inner) as (keyof WorkspaceTransport)[]) {
		if (typeof inner[name] !== "function") continue;
		const fn = (inner[name] as (...a: unknown[]) => Promise<unknown>).bind(
			inner,
		);
		(t as unknown as Record<string, unknown>)[name] = async (
			...args: unknown[]
		) => {
			const result = await fn(...args);
			if (holds.has(name)) {
				holds.delete(name);
				await new Promise<void>((resolve) => waiting.push(resolve));
			}
			return result;
		};
	}
	return {
		transport: t,
		hold: (name: keyof WorkspaceTransport) => holds.add(name),
		release: () => waiting.shift()?.(),
	};
}

const flush = async () => {
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("store: acceptance_validity is always explicit (required-nullable shape)", () => {
	test("detail reads and snapshot folds carry null when nothing is reported", async () => {
		const tx = createFixtureTransport({ now: () => T0 });
		const c = must(
			await tx.createTask({
				idempotency_key: key(),
				repo_id: "local/fixture",
				draft: { ...emptyDraft(), title: "No acceptance" },
			}),
		);
		// a transport that drops the field, like a hub that does not report it
		const silent = {
			...tx,
			source: tx.source,
			getTask: async (id: string) => {
				const r = await tx.getTask(id);
				if (!r.ok) return r;
				const { acceptance_validity: _drop, ...rest } = r.data;
				return { ...r, data: rest as typeof r.data };
			},
		} as WorkspaceTransport;
		const store = new WorkspaceStore({ transport: silent, now: () => T0 });
		await store.boot();
		await store.loadDetail(c.task.id);
		const d = store.detail(c.task.id);
		expect(d && "acceptance_validity" in d).toBe(true);
		expect(d?.acceptance_validity).toBeNull();
		const item = store
			.getState()
			.snapshot?.tasks.find((x) => x.task.id === c.task.id);
		expect(item && "acceptance_validity" in item).toBe(true);
		expect(item?.acceptance_validity).toBeNull();
	});
});

describe("store: no stale verified badge; the display follows the hub", () => {
	async function storeOn() {
		let t = T0;
		const tx = createFixtureTransport({ now: () => t });
		const id = await acceptedTask(tx, "Store validity");
		const h = holdable(tx);
		let r = 0;
		const store = new WorkspaceStore({
			transport: h.transport,
			now: () => t,
			random: () => `rnd-${++r}`,
		});
		await store.boot();
		store.navigate({
			view: "projects",
			repoId: "local/fixture",
			taskId: id,
			requestId: null,
		});
		await flush();
		return {
			tx,
			h,
			store,
			id,
			tick: (ms: number) => {
				t += ms;
			},
		};
	}
	const shown = (s: WorkspaceStore, id: string) =>
		acceptanceValidityDisplay(s.detail(id)?.acceptance_validity, null).status;
	const listed = (s: WorkspaceStore, id: string) =>
		s.getState().snapshot?.tasks.find((x) => x.task.id === id)
			?.acceptance_validity?.status;

	test("after a poll returns invalid, a late older snapshot cannot restore 'verified'", async () => {
		const { tx, h, store, id, tick } = await storeOn();
		expect(shown(store, id)).toBe("valid");
		h.hold("getSnapshot");
		void store.loadSnapshot(); // computed now: stored row still `valid`
		tx.controls.corruptEvidence(id, "diff.patch");
		tick(1000);
		await store.loadDetail(id); // the poll re-checks → invalid
		expect(shown(store, id)).toBe("invalid");
		expect(listed(store, id)).toBe("invalid"); // folded into the list at once
		h.release(); // the older snapshot (valid, older checked_at) lands now
		await flush();
		expect(listed(store, id)).toBe("invalid");
		expect(shown(store, id)).toBe("invalid");
		// the historical acceptance is untouched
		const d = store.detail(id);
		expect(d?.approval_requests.find((x) => x.kind === "result")?.status).toBe(
			"accepted",
		);
		expect(d?.task.stage).toBe("accepted");
	});

	test("sticky invalid comes from the hub: later polls and reloads keep it", async () => {
		const { tx, store, id, tick } = await storeOn();
		tx.controls.corruptEvidence(id, "diff.patch");
		for (let i = 0; i < 3; i++) {
			tick(5000);
			await store.loadDetail(id);
			await store.loadSnapshot();
			expect(shown(store, id)).toBe("invalid");
			expect(listed(store, id)).toBe("invalid");
		}
		// a fresh store (reload) reads the same server state
		const again = new WorkspaceStore({ transport: tx, now: () => T0 + 20_000 });
		await again.boot();
		await again.loadDetail(id);
		expect(shown(again, id)).toBe("invalid");
	});

	test("a non-sticky state follows the hub both ways (unknown → valid)", async () => {
		const { tx, store, id, tick } = await storeOn();
		tx.controls.setAcceptanceValidity(id, "unknown");
		tick(1000);
		await store.loadDetail(id);
		expect(shown(store, id)).toBe("unknown");
		tx.controls.setAcceptanceValidity(id, "valid");
		tick(1000);
		await store.loadDetail(id);
		expect(shown(store, id)).toBe("valid");
	});
});

describe("copy audit (validity strings)", () => {
	test("every validity string is in the audited copy and free of merge/push/deploy wording", () => {
		const copy = allStaticCopy();
		for (const s of [
			...Object.values(VALIDITY_REASON_LABEL),
			...Object.values(ACCEPTED_HISTORY_EVIDENCE_LABEL),
			validityShortLabel(null),
		])
			expect(copy).toContain(s);
		expect(copy.filter((s) => BANNED.test(s))).toEqual([]);
	});
	test("fixture strings after a post-acceptance corruption are free of it too", async () => {
		const { tx } = fixture();
		const id = await acceptedTask(tx);
		tx.controls.corruptEvidence(id, "diff.patch");
		const d = must(await tx.getTask(id));
		const out = JSON.stringify(d);
		expect(BANNED.test(out)).toBe(false);
		for (const a of d.artifacts)
			expect(
				BANNED.test(
					JSON.stringify(must(await tx.getArtifact(id, a.artifact_id))),
				),
			).toBe(false);
	});
});
