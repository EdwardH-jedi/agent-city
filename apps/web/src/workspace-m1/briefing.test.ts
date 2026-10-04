// CEO briefing (multi-repository milestone): a pure, deterministic selector over the one cache. Pins:
// every state (loading / empty / idle / active / attention / observed), each claim links to its task or
// HQ document (no commands), exact recorded timestamps and "time not recorded" when the record has none,
// human_ready vs accepted, integrity-invalid and current-validity-invalid wording identical to HQ, the
// global queue (waiting behind another repository, quarantine pause), freshness from the connection.
import { describe, expect, test } from "bun:test";
import {
	criteriaFromText,
	type ExecutionQueue,
	emptyDraft,
	type WorkspaceSnapshot,
	type WorkspaceTaskListItem,
} from "@agent-city/schema/workspace-m1";
import {
	BRIEFING_FINISHED_LIMIT,
	type BriefingItem,
	type RepoBriefing,
	repoBriefing,
} from "./briefing.ts";
import { createFixtureTransport } from "./fixture-transport.ts";
import {
	dateTime,
	INVALIDATION_LABEL,
	OBSERVED_REPO_NOTE,
	SNAPSHOT_STALE_AFTER_MS,
	UNKNOWN_REPO_NOTE,
	validityShortLabel,
} from "./labels.ts";

const A = "local/alpha";
const B = "local/beta";
const OBS = "observed-example/seen";
const T0 = "2026-10-03T10:00:00.000Z";
const NOW = Date.parse("2026-10-03T10:05:00.000Z");
const ONLINE = {
	status: "online",
	lastConfirmedAt: "2026-10-03T10:04:59.000Z",
};

let n = 0;
const id = (p: string) =>
	`${p}-00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
const mt = () => `task-${id("m").slice(2)}`;

interface ItemOpts {
	repo?: string;
	title?: string;
	stage?: string;
	phase?: string;
	updated?: string;
	engine?: Partial<NonNullable<WorkspaceTaskListItem["engine"]>> | null;
	latest?: Partial<NonNullable<WorkspaceTaskListItem["latest_request"]>> | null;
	validity?: WorkspaceTaskListItem["acceptance_validity"];
	cancelAt?: string | null;
}

function item(o: ItemOpts = {}): WorkspaceTaskListItem {
	const tid = id("wst");
	return {
		task: {
			id: tid,
			repo_id: o.repo ?? A,
			draft: { title: o.title ?? `Task ${tid.slice(-4)}` },
			stage: o.stage ?? "draft",
			updated_at: o.updated ?? T0,
			created_at: T0,
			cancel_requested_at: o.cancelAt ?? null,
			rev: 1,
		},
		phase: o.phase ?? "planning",
		acceptance_validity: o.validity ?? null,
		engine:
			o.engine === undefined || o.engine === null
				? null
				: {
						managed_task_id: mt(),
						state: "queued",
						failure_kind: null,
						state_detail: null,
						cancel_requested_at: null,
						current_run_id: null,
						result_run_id: null,
						attempt_no: null,
						quarantined: false,
						rev: 1,
						...o.engine,
					},
		latest_request: o.latest
			? {
					id: id("wsa"),
					kind: "run",
					status: "pending",
					invalidation_reason: null,
					created_at: T0,
					closed_at: null,
					...o.latest,
				}
			: null,
	} as unknown as WorkspaceTaskListItem;
}

function snap(
	tasks: WorkspaceTaskListItem[],
	o: {
		pending?: {
			task: WorkspaceTaskListItem;
			kind: "run" | "result";
			at?: string;
		}[];
		queue?: Partial<ExecutionQueue>;
		repos?: string[];
		observed?: string[];
		/** The hub's complete per-repository task totals (default: exactly the listed tasks; null = not reported). */
		counts?: Record<string, number> | null;
	} = {},
): WorkspaceSnapshot {
	const repos = o.repos ?? [A, B];
	return {
		provenance: {
			data_source: "hub",
			execution_mode: "simulated",
			live_integration_verified: false,
		},
		repos: repos.map((r) => ({
			repo_id: r,
			base_ref: "main",
			required_checks: ["unit"],
		})),
		observed_repos: (o.observed ?? [OBS]).map((r) => ({
			repo_id: r,
			source: "telemetry",
		})),
		tasks,
		...(o.counts === null
			? {}
			: {
					repo_task_counts: repos.map((r) => ({
						repo_id: r,
						tasks:
							o.counts?.[r] ?? tasks.filter((t) => t.task.repo_id === r).length,
					})),
				}),
		pending_requests: (o.pending ?? []).map((p) => ({
			id: id("wsa"),
			workspace_task_id: p.task.task.id,
			kind: p.kind,
			status: "pending",
			created_at: p.at ?? T0,
		})),
		execution_queue: {
			active: null,
			queued: [],
			claims_paused_by_quarantine: false,
			...o.queue,
		},
		generated_at: T0,
	} as unknown as WorkspaceSnapshot;
}

const brief = (
	s: WorkspaceSnapshot | null,
	repoId = A,
	conn: { status: string; lastConfirmedAt: string | null } = ONLINE,
	// the last successful snapshot read (P2 F-02); by default the read that confirmed the connection
	sync: { confirmedAt: string | null; failedAt: string | null } | undefined = {
		confirmedAt: conn.lastConfirmedAt,
		failedAt: null,
	},
) => repoBriefing({ snapshot: s, repoId, conn, sync, now: NOW });

const items = (b: RepoBriefing): BriefingItem[] =>
	b.sections.flatMap((s) => s.items);

const queueEntry = (t: WorkspaceTaskListItem, at = T0) => ({
	managed_task_id: t.engine?.managed_task_id ?? mt(),
	workspace_task_id: t.task.id,
	repo_id: t.task.repo_id,
	state: t.engine?.state ?? "queued",
	run_requested_at: at,
});

describe("briefing states", () => {
	test("loading before the first snapshot", () => {
		const b = brief(null);
		expect(b.state).toBe("loading");
		expect(b.sections).toEqual([]);
		expect(b.next).toBeNull();
	});

	test("observed-only repository: no work, no next action, no claims", () => {
		const b = brief(snap([item()]), OBS);
		expect(b.state).toBe("observed");
		expect(b.summary).toBe(OBSERVED_REPO_NOTE);
		expect(b.next).toBeNull();
		expect(b.sections).toEqual([]);
	});

	test("a repository neither allowlisted nor observed says so", () => {
		const b = brief(snap([]), "local/nowhere");
		expect(b.state).toBe("empty");
		expect(b.summary).toBe(UNKNOWN_REPO_NOTE);
		expect(b.next).toBeNull();
	});

	test("an allowlisted repository without tasks is empty; other repositories' tasks do not count", () => {
		const b = brief(snap([item({ repo: B })]), A);
		expect(b.state).toBe("empty");
		expect(b.summary).toBe("No tasks are recorded for this repository yet.");
		expect(b.next?.text).toBe("Assign work to start the first task.");
		expect(b.next?.target).toBeNull();
	});

	test("idle: only finished work; accepted time comes from the accept decision", () => {
		const closed = "2026-10-03T09:30:00.000Z";
		const acc = item({
			stage: "accepted",
			phase: "accepted",
			latest: { kind: "result", status: "accepted", closed_at: closed },
			validity: {
				decision_id: id("wsd"),
				status: "valid",
				reason: null,
				detail: null,
				checked_at: "2026-10-03T10:04:50.000Z",
				first_invalid_at: null,
				evidence_bundle_digest: null,
			},
		});
		const b = brief(snap([acc]));
		expect(b.state).toBe("idle");
		expect(b.summary).toBe(
			"Nothing is running or waiting for Edward. 1 accepted.",
		);
		const [it] = items(b);
		expect(it?.kind).toBe("accepted");
		expect(it?.at).toBe(closed);
		expect(it?.when).toBe(`accepted ${dateTime(closed)}`);
		expect(it?.text).toContain("current evidence verified");
		expect(b.next?.target).toBeNull();
	});

	test("an accepted result without a recorded decision time says so (never invented)", () => {
		const acc = item({ stage: "accepted", phase: "accepted", latest: null });
		const [it] = items(brief(snap([acc])));
		expect(it?.at).toBeNull();
		expect(it?.when).toBe("time not recorded");
		expect(it?.text).toContain(
			"verification unavailable (not reported by the hub)",
		);
	});
});

describe("decisions, attention and the next human action", () => {
	test("pending Gate 1 / Gate 2 link to their HQ documents; result ready is NOT accepted", () => {
		const g1 = item({
			stage: "awaiting_run_approval",
			phase: "awaiting_run_approval",
			title: "Needs run",
		});
		const g2 = item({
			stage: "awaiting_acceptance",
			phase: "awaiting_acceptance",
			title: "Needs accept",
			engine: { state: "human_ready" },
		});
		const s = snap([g1, g2], {
			pending: [
				{ task: g2, kind: "result", at: "2026-10-03T09:00:00.000Z" },
				{ task: g1, kind: "run", at: "2026-10-03T09:10:00.000Z" },
			],
		});
		const b = brief(s);
		expect(b.state).toBe("attention");
		const dec = b.sections.find((x) => x.id === "decisions")?.items ?? [];
		// oldest first, like the HQ inbox
		expect(dec.map((i) => i.kind)).toEqual([
			"needs_acceptance",
			"needs_approval",
		]);
		const [acc, run] = dec;
		expect(acc?.text).toBe(
			"Result ready (engine human_ready) — NOT accepted yet.",
		);
		expect(acc?.target).toEqual({
			view: "hq",
			repoId: null,
			taskId: g2.task.id,
			requestId: s.pending_requests[0]?.id,
		});
		expect(acc?.requestId).toBe(s.pending_requests[0]?.id as string);
		expect(run?.when).toBe(
			`waiting since ${dateTime("2026-10-03T09:10:00.000Z")}`,
		);
		// next action = the oldest pending decision
		expect(b.next?.target).toEqual(acc?.target as never);
		expect(b.next?.label).toBe("Open result acceptance · Needs accept");
		expect(b.next?.text).toBe(
			"Inspect the evidence, then decide on the result in Headquarters.",
		);
		expect(b.summary).toBe(
			"1 awaiting execution approval · 1 result ready, not accepted.",
		);
	});

	test("a gate the inbox list does not carry is still Edward's decision (never a draft)", () => {
		const g1 = item({
			stage: "awaiting_run_approval",
			phase: "awaiting_run_approval",
			latest: { kind: "run", status: "pending", created_at: T0 },
		});
		const [it] = items(brief(snap([g1])));
		expect(it?.kind).toBe("needs_approval");
		expect(it?.requestId).toBe(g1.latest_request?.id as string);
		expect(it?.target.view).toBe("hq");
		expect(it?.when).toBe(`waiting since ${dateTime(T0)}`);
	});

	test("integrity-invalid result and invalid current validity use the HQ wording", () => {
		const integrity = item({
			stage: "execution_ended",
			phase: "failed",
			latest: {
				kind: "result",
				status: "invalidated",
				invalidation_reason: "integrity_failed",
				closed_at: "2026-10-03T09:40:00.000Z",
			},
		});
		const v = {
			decision_id: id("wsd"),
			status: "invalid" as const,
			reason: "source_evidence_changed" as const,
			detail: null,
			checked_at: "2026-10-03T10:00:00.000Z",
			first_invalid_at: "2026-10-03T09:59:00.000Z",
			evidence_bundle_digest: null,
		};
		const invalid = item({ stage: "accepted", phase: "accepted", validity: v });
		const b = brief(snap([integrity, invalid]));
		expect(b.state).toBe("attention");
		const att = b.sections.find((x) => x.id === "attention")?.items ?? [];
		const ii = att.find((i) => i.kind === "integrity_invalid");
		expect(ii?.text).toBe(
			`Result invalidated before acceptance: ${INVALIDATION_LABEL.integrity_failed}. Nothing was accepted.`,
		);
		expect(ii?.when).toBe(
			`invalidated ${dateTime("2026-10-03T09:40:00.000Z")}`,
		);
		const vi = att.find((i) => i.kind === "validity_invalid");
		expect(vi?.text).toBe(`Accepted — ${validityShortLabel(v)}.`);
		expect(vi?.when).toBe(
			`first found invalid ${dateTime(v.first_invalid_at)}`,
		);
		// an invalid acceptance is never also listed as a plain "accepted" result
		expect(items(b).filter((i) => i.taskId === invalid.task.id)).toHaveLength(
			1,
		);
	});

	test("blocked / interrupted / failed / cancelled / quarantined are attention items with the failure reason", () => {
		const blocked = item({
			stage: "execution_ended",
			phase: "blocked",
			engine: { state: "blocked", failure_kind: "scope_violation" },
		});
		const interrupted = item({
			stage: "execution_ended",
			phase: "interrupted",
			engine: { state: "interrupted", failure_kind: "interrupted" },
		});
		const cancelled = item({ stage: "cancelled", phase: "cancelled" });
		const quarantined = item({
			stage: "execution_ended",
			phase: "interrupted",
			engine: { state: "interrupted", quarantined: true },
		});
		const b = brief(snap([blocked, interrupted, cancelled, quarantined]));
		const kinds = Object.fromEntries(items(b).map((i) => [i.taskId, i.kind]));
		expect(kinds[blocked.task.id]).toBe("blocked");
		expect(kinds[interrupted.task.id]).toBe("interrupted");
		expect(kinds[cancelled.task.id]).toBe("cancelled");
		expect(kinds[quarantined.task.id]).toBe("quarantined");
		const blockedItem = items(b).find((i) => i.taskId === blocked.task.id);
		expect(blockedItem?.text).toBe(
			"Blocked — The change touched files outside the approved scope.",
		);
		expect(blockedItem?.when).toBe(`last task update ${dateTime(T0)}`);
		expect(b.counts.attention).toBe(3);
		expect(b.counts.cancelled).toBe(1);
		expect(b.state).toBe("attention");
		// the next action points at a stopped task, not at the merely cancelled one
		expect(b.next?.target).not.toEqual({
			view: "projects",
			repoId: A,
			taskId: cancelled.task.id,
			requestId: null,
		});
	});

	test("a cancelled task says which cancellation the record shows — withdrawn, confirmed, or neither", () => {
		const closed = "2026-10-03T10:05:00.000Z";
		const withdrawn = item({
			stage: "cancelled",
			phase: "cancelled",
			latest: {
				kind: "run",
				status: "invalidated",
				invalidation_reason: "withdrawn",
				closed_at: closed,
			},
		});
		const confirmed = item({
			stage: "cancelled",
			phase: "cancelled",
			engine: { state: "cancelled", failure_kind: "cancelled" },
			latest: { kind: "run", status: "approved", closed_at: closed },
		});
		const bare = item({ stage: "cancelled", phase: "cancelled" });
		const b = brief(snap([withdrawn, confirmed, bare]));
		const byId = Object.fromEntries(items(b).map((i) => [i.taskId, i]));
		expect(byId[withdrawn.task.id]?.text).toBe(
			"Cancelled — the execution approval request was withdrawn; nothing ran.",
		);
		expect(byId[withdrawn.task.id]?.when).toBe(`withdrawn ${dateTime(closed)}`);
		expect(byId[confirmed.task.id]?.text).toBe(
			"Cancelled — the engine confirmed the execution's termination.",
		);
		expect(byId[confirmed.task.id]?.when).toBe(
			`last task update ${dateTime(T0)}`,
		);
		// no record of either: stated without guessing
		expect(byId[bare.task.id]?.text).toBe("Cancelled.");
	});

	test("cancellation requested stays in flight until the engine confirms", () => {
		const at = "2026-10-03T10:01:00.000Z";
		const c = item({
			stage: "cancel_requested",
			phase: "cancel_requested",
			engine: { state: "executing", cancel_requested_at: at },
		});
		const b = brief(snap([c]));
		const [it] = items(b);
		expect(it?.kind).toBe("cancel_requested");
		expect(it?.text).toBe(
			"Cancellation requested — not cancelled until the engine confirms termination.",
		);
		expect(it?.when).toBe(`requested ${dateTime(at)}`);
		expect(b.state).toBe("active");
	});

	test("drafts and requested changes offer the next step", () => {
		const d = item({ title: "Draft one", updated: "2026-10-03T09:00:00.000Z" });
		const b = brief(snap([d]));
		expect(b.state).toBe("idle");
		expect(items(b)[0]?.kind).toBe("draft");
		expect(items(b)[0]?.when).toBe(
			`last saved ${dateTime("2026-10-03T09:00:00.000Z")}`,
		);
		expect(b.next?.text).toBe(
			"Complete the draft, save it, then submit it for execution approval.",
		);
		expect(b.next?.label).toBe("Open task · Draft one");
	});
});

describe("the global queue", () => {
	test("running holds the slot; queued work in the same repository names its position", () => {
		const run = item({
			stage: "running",
			phase: "implementing",
			title: "Running one",
			engine: { state: "executing", attempt_no: 1 },
		});
		const q = item({
			stage: "queued",
			phase: "queued",
			title: "Waiting one",
			engine: { state: "queued" },
		});
		const s = snap([q, run], {
			queue: {
				active: queueEntry(run, "2026-10-03T09:50:00.000Z"),
				queued: [queueEntry(q, "2026-10-03T09:55:00.000Z")],
			},
		});
		const b = brief(s);
		expect(b.state).toBe("active");
		const now = b.sections.find((x) => x.id === "now")?.items ?? [];
		expect(now.map((i) => i.kind)).toEqual(["running", "queued"]);
		expect(now[0]?.text).toBe(
			"Implementing (attempt 1) · holds the engine slot.",
		);
		expect(now[0]?.when).toBe(
			`approved to run ${dateTime("2026-10-03T09:50:00.000Z")}`,
		);
		expect(now[1]?.text).toBe(
			"Queued · position 1 of 1 · waiting behind local/alpha · Running one.",
		);
		expect(b.next?.text).toBe(
			"Nothing needs Edward now. Wait for the stages to finish, or cancel the execution.",
		);
		expect(b.notes).toEqual([]);
	});

	test("queued work waits behind ANOTHER repository's execution, and says so", () => {
		const other = item({
			repo: B,
			stage: "running",
			phase: "verifying",
			title: "Beta work",
			engine: { state: "verifying" },
		});
		const mine = item({
			stage: "queued",
			phase: "queued",
			engine: { state: "queued" },
		});
		const s = snap([mine, other], {
			queue: { active: queueEntry(other), queued: [queueEntry(mine)] },
		});
		const b = brief(s, A);
		const [it] = items(b);
		expect(it?.kind).toBe("queued");
		expect(it?.text).toBe(
			"Queued · position 1 of 1 · waiting behind local/beta · Beta work (another repository).",
		);
		expect(b.notes).toContain(
			"The single engine slot is held by local/beta; this repository's queued work waits for it.",
		);
		// B's own briefing shows B's execution holding the slot
		const bb = brief(s, B);
		expect(items(bb)[0]?.text).toBe("Verifying · holds the engine slot.");
	});

	test("a global quarantine pause is stated; a queued execution missing from the queue is 'unknown'", () => {
		const q = item({
			stage: "queued",
			phase: "queued",
			engine: { state: "queued" },
		});
		const b = brief(
			snap([q], { queue: { claims_paused_by_quarantine: true } }),
		);
		expect(b.notes).toEqual([
			"The engine is not claiming work: a process is quarantined (any repository).",
		]);
		expect(items(b)[0]?.text).toBe(
			"Queued · claims paused: a process is quarantined (any repository).",
		);
		expect(items(b)[0]?.when).toBe("time not recorded");
		const b2 = brief(snap([q]));
		expect(items(b2)[0]?.text).toBe("Queued · queue position unknown.");
	});
});

describe("links, freshness and determinism", () => {
	test("every claim navigates to its own task (same repository) or HQ document", () => {
		const tasks = [
			item({ stage: "awaiting_run_approval", phase: "awaiting_run_approval" }),
			item({ stage: "execution_ended", phase: "failed" }),
			item({ stage: "accepted", phase: "accepted" }),
			item({ stage: "rejected", phase: "rejected" }),
			item({ stage: "changes_requested", phase: "changes_requested" }),
			item({ stage: "draft", phase: "planning" }),
		];
		const s = snap(tasks, {
			pending: [{ task: tasks[0] as never, kind: "run" }],
		});
		const b = brief(s);
		expect(items(b)).toHaveLength(tasks.length);
		for (const i of items(b)) {
			if (i.target.view === "hq") {
				expect(i.requestId).not.toBeNull();
				expect(i.target.requestId).toBe(i.requestId);
				expect(i.target.taskId).toBe(i.taskId);
			} else {
				expect(i.target).toEqual({
					view: "projects",
					repoId: A,
					taskId: i.taskId,
					requestId: null,
				});
			}
			expect(i.linkLabel.length).toBeGreaterThan(0);
		}
	});

	test("finished results: newest first, at most the limit, the rest counted", () => {
		const finished = Array.from(
			{ length: BRIEFING_FINISHED_LIMIT + 2 },
			(_, k) =>
				item({
					stage: "accepted",
					phase: "accepted",
					latest: {
						kind: "result",
						status: "accepted",
						closed_at: `2026-10-03T0${k}:00:00.000Z`,
					},
				}),
		);
		const b = brief(snap(finished));
		const f = b.sections.find((x) => x.id === "finished")?.items ?? [];
		expect(f).toHaveLength(BRIEFING_FINISHED_LIMIT);
		expect(f[0]?.at).toBe("2026-10-03T06:00:00.000Z");
		expect(b.olderFinished).toBe(2);
		expect(b.counts.accepted).toBe(BRIEFING_FINISHED_LIMIT + 2);
	});

	test("freshness comes from the connection: current / stale / offline with the last confirmed time", () => {
		const s = snap([item()]);
		expect(brief(s).freshness).toBe("current");
		expect(brief(s).freshnessLine).toBe(
			"From the hub record confirmed at 10:04:59 UTC.",
		);
		const stale = brief(s, A, {
			status: "online",
			lastConfirmedAt: "2026-10-03T10:00:00.000Z",
		});
		expect(stale.freshness).toBe("stale");
		expect(stale.freshnessLine).toBe(
			"Connection stale · last confirmed 10:00:00 UTC · this briefing may be out of date.",
		);
		const off = brief(s, A, {
			status: "offline",
			lastConfirmedAt: "2026-10-03T10:04:00.000Z",
		});
		expect(off.freshness).toBe("offline");
		expect(off.freshnessLine).toContain(
			"Offline · last confirmed 10:04:00 UTC",
		);
		// stale data is never presented without its age; the claims themselves are unchanged
		expect(items(off)).toEqual(items(brief(s)));
	});

	test("deterministic: the same record gives the same briefing; no numbers beyond recorded counts", () => {
		const s = snap([
			item({
				stage: "running",
				phase: "reviewing",
				engine: { state: "reviewing" },
			}),
			item({ stage: "draft", phase: "planning" }),
		]);
		expect(brief(s)).toEqual(brief(s));
		const text = JSON.stringify(brief(s));
		expect(text).not.toMatch(/%|score|productiv|cost|\$|model/i);
	});
});

describe("against the fixture transport (real contract shapes)", () => {
	test("pending requests, queue and invalid acceptance agree with the snapshot the UI shows", async () => {
		let t = Date.parse("2026-10-03T10:00:00.000Z");
		const tx = createFixtureTransport({ now: () => t });
		const make = async (title: string) => {
			const c = await tx.createTask({
				idempotency_key: `brief-${title.replaceAll(" ", "-")}`,
				repo_id: "local/fixture",
				draft: {
					...emptyDraft(),
					title,
					objective: "Briefing journey.",
					criteria: criteriaFromText("Works"),
					criterion_checks: [{ criterion: "Works", checks: ["unit"] }],
					scope: { allowed: ["."], protected: [] },
				},
			});
			if (!c.ok) throw new Error("create");
			const p = await tx.publishProposal(c.data.task.id, {
				expected_rev: c.data.task.rev,
			});
			if (!p.ok) throw new Error("publish");
			return { taskId: c.data.task.id, req: p.data.approval_requests[0] };
		};
		const approve = async (x: Awaited<ReturnType<typeof make>>) => {
			if (!x.req) throw new Error("req");
			const ch = await tx.issueChallenge(x.req.id, {
				kind: "run",
				binding_hash: x.req.binding_hash,
				expected_request_rev: x.req.rev,
			});
			if (!ch.ok) throw new Error("challenge");
			const d = await tx.decide(
				x.req.id,
				JSON.stringify({
					idempotency_key: `brief-d-${x.taskId.slice(-6)}`,
					kind: "run",
					action: "approve",
					binding_hash: x.req.binding_hash,
					expected_request_rev: ch.data.request_rev,
					challenge: ch.data.challenge,
					confirmation_text: "Edward",
					reason: null,
				}),
			);
			if (!d.ok) throw new Error("decide");
		};
		const one = await make("First run");
		t += 1000;
		const two = await make("Second run");
		t += 1000;
		const three = await make("Waits for Edward");
		await approve(one);
		t += 1000;
		await approve(two);
		tx.controls.advance(one.taskId); // first execution starts
		const s = await tx.getSnapshot();
		if (!s.ok) throw new Error("snapshot");
		const b = repoBriefing({
			snapshot: s.data,
			repoId: "local/fixture",
			conn: { status: "online", lastConfirmedAt: new Date(t).toISOString() },
			sync: { confirmedAt: new Date(t).toISOString(), failedAt: null },
			now: t,
		});
		const byTask = Object.fromEntries(items(b).map((i) => [i.taskId, i]));
		expect(byTask[one.taskId]?.kind).toBe("running");
		expect(byTask[two.taskId]?.kind).toBe("queued");
		expect(byTask[two.taskId]?.text).toContain("Queued · position 1 of 1");
		expect(byTask[three.taskId]?.kind).toBe("needs_approval");
		expect(byTask[three.taskId]?.requestId).toBe(three.req?.id as string);
		// every pending request of the repository appears exactly once
		const pending = s.data.pending_requests.map((r) => r.id);
		expect(
			items(b)
				.map((i) => i.requestId)
				.filter(Boolean)
				.sort(),
		).toEqual([...pending].sort());
		// the empty second repository and the observed one
		expect(
			repoBriefing({
				snapshot: s.data,
				repoId: "local/empty-sandbox",
				conn: { status: "online", lastConfirmedAt: new Date(t).toISOString() },
				sync: { confirmedAt: new Date(t).toISOString(), failedAt: null },
				now: t,
			}).state,
		).toBe("empty");
		expect(
			repoBriefing({
				snapshot: s.data,
				repoId: "observed-example/telemetry-only",
				conn: { status: "online", lastConfirmedAt: new Date(t).toISOString() },
				sync: { confirmedAt: new Date(t).toISOString(), failedAt: null },
				now: t,
			}).state,
		).toBe("observed");
	});
});

// P2 F-01: the snapshot's task list is a bounded window; only the hub's complete count may say a repository
// has no tasks, and what the window leaves out is stated (docs/workspace-m1/CORRECTIVE_P2_2026-10-04.md).
describe("P2 F-01 — a truncated task window never reads as an empty repository", () => {
	const manyB = (k: number) =>
		Array.from({ length: k }, (_, i) => item({ repo: B, title: `B${i}` }));

	test("the reviewed case: A has recorded tasks but none in the window → not empty, the window is stated", () => {
		const b = brief(snap(manyB(3), { counts: { [A]: 1, [B]: 500 } }));
		expect(b.state).not.toBe("empty");
		expect(b.summary).not.toContain("No tasks are recorded");
		expect(b.summary).toContain("Showing 0 of 1 recorded tasks");
		expect(b.summary).toContain("1 task is not in this snapshot");
		expect(b.window).toEqual({ shown: 0, recorded: 1, complete: false });
		// every inbox / queue entry resolves, so nothing hidden can be waiting for Edward
		expect(b.state).toBe("idle");
		expect(
			b.summary.startsWith("Nothing is running or waiting for Edward."),
		).toBe(true);
	});

	test("A's pending request (pinned into the window by the hub) is attributed to A, with older A tasks stated", () => {
		const a = item({
			stage: "awaiting_run_approval",
			phase: "awaiting_run_approval",
			title: "A still awaiting approval",
		});
		const s = snap([a, ...manyB(4)], {
			pending: [{ task: a, kind: "run" }],
			counts: { [A]: 7, [B]: 900 },
		});
		const b = brief(s);
		expect(b.state).toBe("attention");
		expect(b.counts.needsApproval).toBe(1);
		expect(items(b).map((i) => i.requestId)).toEqual([
			s.pending_requests[0]?.id as string,
		]);
		expect(b.summary).toBe(
			`1 awaiting execution approval. ${"Showing 1 of 7 recorded tasks; 6 tasks are not in this snapshot (it lists the most recently updated tasks, plus every task awaiting a decision or in the execution queue)."}`,
		);
		expect(b.window).toEqual({ shown: 1, recorded: 7, complete: false });
	});

	test("an inbox entry the window cannot attribute + hidden A tasks → attention, no quiet claim, Headquarters next", () => {
		const orphan = item({ repo: A, stage: "awaiting_run_approval" }); // not in the window
		const s = snap(manyB(2), {
			pending: [{ task: orphan, kind: "run" }],
			counts: { [A]: 1, [B]: 2 },
		});
		const b = brief(s);
		expect(b.state).toBe("attention");
		expect(b.summary).not.toContain("Nothing is running or waiting");
		expect(b.notes.some((x) => x.includes("could not be matched"))).toBe(true);
		expect(b.next?.target).toEqual({
			view: "hq",
			repoId: null,
			taskId: null,
			requestId: null,
		});
		// B shows all of its tasks: an unattributable entry cannot be B's, so B stays quiet and complete
		const bb = brief(s, B);
		expect(bb.window).toEqual({ shown: 2, recorded: 2, complete: true });
		expect(bb.notes.some((x) => x.includes("could not be matched"))).toBe(
			false,
		);
	});

	test("an inbox list at its cap is not proof that nothing else waits", () => {
		const bs = manyB(500);
		const s = snap(bs, {
			pending: bs.map((t) => ({ task: t, kind: "run" as const })),
			counts: { [A]: 2, [B]: 500 },
		});
		const b = brief(s);
		expect(b.state).toBe("attention");
		expect(b.summary).not.toContain("Nothing is running or waiting");
	});

	test("exact boundary: shown = recorded is complete (summary unchanged); one hidden task is stated", () => {
		const a = item({ stage: "accepted", phase: "accepted" });
		const full = brief(snap([a], { counts: { [A]: 1 } }));
		expect(full.window).toEqual({ shown: 1, recorded: 1, complete: true });
		expect(full.summary).toBe(
			"Nothing is running or waiting for Edward. 1 accepted.",
		);
		const cut = brief(snap([a], { counts: { [A]: 2 } }));
		expect(cut.window?.complete).toBe(false);
		expect(cut.summary).toContain(
			"Showing 1 of 2 recorded tasks; 1 task is not",
		);
	});

	test("a genuinely empty repository is empty (count 0) even when another repository is truncated", () => {
		const b = brief(snap(manyB(5), { counts: { [A]: 0, [B]: 5000 } }));
		expect(b.state).toBe("empty");
		expect(b.summary).toBe("No tasks are recorded for this repository yet.");
		expect(b.window).toEqual({ shown: 0, recorded: 0, complete: true });
		expect(
			brief(snap(manyB(5), { counts: { [A]: 0, [B]: 5000 } }), B).window,
		).toEqual({ shown: 5, recorded: 5000, complete: false });
	});

	test("counts not reported (an older hub): never empty, never a count claim", () => {
		const b = brief(snap(manyB(1), { counts: null }));
		expect(b.state).not.toBe("empty");
		expect(b.summary).toContain(
			"whether this repository has others is not reported",
		);
		expect(b.window).toEqual({ shown: 0, recorded: null, complete: false });
	});
});

// P2 F-02: the briefing's facts are the snapshot's — their age is the last successful snapshot read, never
// the connection's liveness or a task detail read (docs/workspace-m1/CORRECTIVE_P2_2026-10-04.md).
describe("P2 F-02 — a fresh connection never certifies stale repository facts", () => {
	const at = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString();
	const fresh = { status: "online", lastConfirmedAt: at(500) }; // e.g. a task detail just answered

	test("the reviewed case: connection fresh, snapshot last confirmed 61 s ago → stale, with the snapshot's time", () => {
		const s = snap([
			item({ stage: "awaiting_run_approval", phase: "awaiting_run_approval" }),
		]);
		const b = brief(s, A, fresh, { confirmedAt: at(61_000), failedAt: null });
		expect(b.freshness).toBe("stale");
		expect(b.freshnessLine).toBe(
			"Repository record stale · last confirmed 10:03:59 UTC · this briefing may be out of date.",
		);
		expect(b.freshnessLine).not.toContain("10:04:59");
		// the claims stay (last known data is kept) — only their freshness is qualified
		expect(b.counts.needsApproval).toBe(1);
	});

	test("a failed snapshot read since the last success is stale even within the threshold", () => {
		const b = brief(snap([item()]), A, fresh, {
			confirmedAt: at(2_000),
			failedAt: at(1_000),
		});
		expect(b.freshness).toBe("stale");
		expect(b.freshnessLine).toBe(
			"Repository record not refreshed — the latest read failed · last confirmed 10:04:58 UTC · this briefing may be out of date.",
		);
	});

	test("threshold boundary: exactly SNAPSHOT_STALE_AFTER_MS old is current, one millisecond more is stale", () => {
		const s = snap([item()]);
		const edge = brief(s, A, fresh, {
			confirmedAt: at(SNAPSHOT_STALE_AFTER_MS),
			failedAt: null,
		});
		expect(edge.freshness).toBe("current");
		expect(edge.freshnessLine).toBe(
			"From the hub record confirmed at 10:04:50 UTC.",
		);
		const past = brief(s, A, fresh, {
			confirmedAt: at(SNAPSHOT_STALE_AFTER_MS + 1),
			failedAt: null,
		});
		expect(past.freshness).toBe("stale");
	});

	test("never confirmed (no sync record) is never current", () => {
		// called directly: the helper would supply its default sync for an explicit undefined
		const b = repoBriefing({
			snapshot: snap([item()]),
			repoId: A,
			conn: fresh,
			sync: undefined,
			now: NOW,
		});
		expect(b.freshness).toBe("stale");
		expect(b.freshnessLine).toContain("last confirmed never");
	});

	test("an offline connection still reads offline, with the snapshot's own confirmation time", () => {
		const b = brief(
			snap([item()]),
			A,
			{ status: "offline", lastConfirmedAt: at(500) },
			{ confirmedAt: at(30_000), failedAt: at(1_000) },
		);
		expect(b.freshness).toBe("offline");
		expect(b.freshnessLine).toContain("Offline · last confirmed 10:04:30 UTC");
	});

	test("an accepted result's validity inside a stale briefing is never shown as freshly verified", () => {
		const acc = item({
			stage: "accepted",
			phase: "accepted",
			latest: { kind: "result", status: "accepted", closed_at: T0 },
			validity: {
				decision_id: id("wsd"),
				status: "valid",
				reason: null,
				detail: null,
				checked_at: at(5_000),
				first_invalid_at: null,
				evidence_bundle_digest: null,
			},
		});
		const s = snap([acc]);
		const current = items(
			brief(s, A, fresh, { confirmedAt: at(1_000), failedAt: null }),
		)[0];
		expect(current?.text).toContain("current evidence verified");
		const stale = items(
			brief(s, A, fresh, { confirmedAt: at(1_000), failedAt: at(500) }),
		)[0];
		expect(stale?.text).toContain("may be out of date");
		expect(stale?.text).not.toContain("current evidence verified");
	});
});
