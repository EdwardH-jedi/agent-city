// 예시 데이터 for `?demo=1` only: a fixed, made-up village so the screen can be looked at without a
// running Office. Everything is built from the page's load time; nothing is fetched and no name is a
// real repo. The live board never uses it, and the screen says "예시 데이터" while it is shown.
import type {
	MachineView,
	RunDisplay,
	RunEventView,
	RunView,
} from "@agent-city/schema";
import type { Districts, RepoView } from "../useHub.ts";
import { type EventsByRun, runKey } from "./types.ts";

export const isDemo = (search: string): boolean =>
	new URLSearchParams(search).get("demo") === "1";

export const DEMO_LABEL = "예시 데이터";

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface DemoData {
	runs: RunView[];
	machines: MachineView[];
	districts: Districts;
	eventsByRun: EventsByRun;
}

export function demoData(t0: number): DemoData {
	const at = (agoMs: number) => new Date(t0 - agoMs).toISOString();
	const run = (
		project: string,
		workflow: string,
		state: RunDisplay,
		over: Partial<RunView> = {},
	): RunView => ({
		machine_id: "cockpit",
		run_id: `${workflow}-1`,
		project,
		workflow_id: workflow,
		phase: "Implementation",
		status: "RUNNING",
		reason: null,
		alert: null,
		last_progress_at: at(2 * MIN),
		idle_seconds: 4,
		completed: [],
		tokens_today: 18_400,
		usage_unknown: false,
		evidence_verified: true,
		last_event_sequence: 4,
		ledger_revision: 1,
		observed_at: at(8_000),
		reported_at: at(8_000),
		display: state,
		last_display: state,
		needs_owner: ["waiting_owner", "hold", "needs_reconcile"].includes(state),
		...over,
	});
	const done = (project: string, workflow: string, agoMs: number) =>
		run(project, workflow, "passed", {
			phase: "Report",
			status: "PASSED",
			last_progress_at: at(agoMs),
		});

	const runs: RunView[] = [
		run("demo/harbor", "harbor-plan", "waiting_owner", {
			phase: "Approval",
			status: "WAITING_OWNER",
			reason: "AWAITING_PLAN_APPROVAL",
			last_progress_at: at(12 * MIN),
		}),
		run("demo/lantern", "lantern-fix", "hold", {
			phase: "Independent Review",
			status: "HOLD",
			reason: "REVIEW_BUDGET_EXHAUSTED",
			alert: "REVIEW_BUDGET_EXHAUSTED",
			last_progress_at: at(41 * MIN),
		}),
		run("demo/orchard", "orchard-api", "running"),
		run("demo/orchard", "orchard-tests", "running", {
			phase: "QA",
			tokens_today: 9_250,
		}),
		run("demo/meadow", "meadow-docs", "running", {
			phase: "Independent Review",
			tokens_today: 31_020,
		}),
		run("demo/garnet", "garnet-cli", "running", {
			phase: "Plan",
			tokens_today: 2_100,
		}),
		done("demo/quarry", "quarry-ui", MIN),
		done("demo/willow", "willow-sync", 130 * MIN),
		run("demo/cinder", "cinder-port", "partial", {
			phase: "Report",
			status: "PARTIAL",
			reason: "PRESERVED_ON_HOLD",
			last_progress_at: at(30 * HOUR),
		}),
		run("demo/ferry", "ferry-notes", "unverified", {
			phase: "Report",
			status: "UNVERIFIED",
			reason: "DISPATCH_STOPPED",
			last_progress_at: at(26 * HOUR),
		}),
		done("demo/beacon", "beacon-auth", 5 * HOUR),
		done("demo/hollow", "hollow-cache", 9 * HOUR),
	];

	const ev = (
		sequence: number,
		task: string,
		agoMs: number,
		over: Partial<RunEventView> = {},
	): RunEventView => ({
		sequence,
		transition: "task.completed",
		occurred_at: at(agoMs),
		task_id: task,
		attempt: 1,
		outcome: "passed",
		reason: null,
		review_verdict: null,
		commit: null,
		base_commit: null,
		diff_digest: null,
		tree_digest: null,
		test_run_key: null,
		model: null,
		from_model: null,
		to_model: null,
		...over,
	});
	const keyOf = (workflow: string): string => {
		const r = runs.find((x) => x.workflow_id === workflow);
		return r ? runKey(r) : workflow;
	};
	const eventsByRun: EventsByRun = new Map([
		[keyOf("quarry-ui"), [ev(3, "T3", MIN), ev(2, "T2", 9 * MIN)]],
		[
			keyOf("orchard-api"),
			[
				ev(2, "T1", 17 * MIN, {
					transition: "task.escalated",
					outcome: null,
					from_model: "sonnet",
					to_model: "opus",
				}),
			],
		],
		[keyOf("meadow-docs"), [ev(4, "T2", 24 * MIN)]],
		[keyOf("willow-sync"), [ev(5, "T4", 132 * MIN)]],
	]);

	const machine = (
		id: MachineView["id"],
		status: MachineView["status"],
	): MachineView => ({
		id,
		hostname: null,
		heartbeat_at: status === "unobserved" ? null : at(6_000),
		interval_s: 30,
		status,
	});

	const repo = (id: string, pushedAgoMs: number): RepoView => ({
		id,
		is_private: true,
		is_archived: false,
		is_fork: false,
		language: null,
		pushed_at: at(pushedAgoMs),
		commits_30d: null,
		open_prs: null,
		open_issues: null,
		ci_status: "none",
		ci_updated_at: null,
		district: "demo",
		is_local_only: false,
		synced_at: null,
		active_sessions: 0,
	});

	return {
		runs,
		machines: [
			machine("cockpit", "online"),
			machine("forge", "online"),
			machine("spine", "online"),
		],
		districts: {
			demo: [
				repo("demo/orchard", 3 * HOUR),
				repo("demo/attic", 40 * 24 * HOUR),
				repo("demo/basalt", 60 * 24 * HOUR),
			],
		},
		eventsByRun,
	};
}
