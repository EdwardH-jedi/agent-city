// 예시 데이터 for `?demo=1` only: a fixed, made-up village so the screen can be looked at without a
// running Office. Everything is built from the page's load time; nothing is fetched and no name is a
// real repo. The live board never uses it, and the screen says "예시 데이터" while it is shown.
import type {
	Event,
	MachineView,
	RunDisplay,
	RunEventView,
	RunView,
	Session,
} from "@agent-city/schema";
import type { Districts, RepoView } from "../useHub.ts";
import { PASSED_TEXT } from "./copy.ts";
import { currentRuns, type EventsByRun, runKey } from "./types.ts";
import { emptyWatch, type Watch } from "./visits.ts";

export { DEMO_LABEL, isDemo } from "./demo-flag.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface DemoData {
	/** `case=done` only: what the screen "saw" a moment ago (a run finishing), as visits.ts would. */
	watch?: Watch;
	runs: RunView[];
	machines: MachineView[];
	districts: Districts;
	eventsByRun: EventsByRun;
	sessions: Session[];
	/** Session events for the right panel's terminal tails (15 §3.1). */
	events: Event[];
}

/**
 * `?demo=1&case=calm`: nothing waits for the owner (no 결재, no 멈춤, no 입력 대기). `case=busy`: many
 * sessions in many projects, so the right panel's caps and folds show. `case=done` (17 §3): a calm day
 * where one building has just finished (its confetti, for 20 s after the page opens) and one finished
 * earlier today (its flag); few buildings, so both stand. Anything else: the default.
 */
export type DemoCase = "default" | "calm" | "busy" | "done";
export function demoCaseOf(search: string): DemoCase {
	const c = new URLSearchParams(search).get("case");
	return c === "calm" || c === "busy" || c === "done" ? c : "default";
}

export function demoData(t0: number, kase: DemoCase = "default"): DemoData {
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

	const all: RunView[] = [
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
		// decision D2: Office's loop ended for the day with tasks left
		run("demo/ember", "ember-batch", "paused", {
			status: "READY",
			reason: "DISPATCH_STOPPED",
			last_progress_at: at(3 * HOUR),
		}),
	];
	// calm: nothing waits for the owner and nothing is stopped
	// done: the calm runs of five projects; quarry has just finished, willow finished earlier today
	const sinceMidnight = t0 - new Date(t0).setHours(0, 0, 0, 0);
	const DONE_CASE = new Set([
		"demo/orchard",
		"demo/meadow",
		"demo/garnet",
		"demo/quarry",
		"demo/willow",
	]);
	const runs =
		kase === "calm"
			? all.filter(
					(r) => !r.needs_owner && !["hold", "stopped"].includes(r.display),
				)
			: kase === "done"
				? all
						.filter((r) => DONE_CASE.has(r.project ?? ""))
						.map((r) =>
							r.project === "demo/willow"
								? {
										...r,
										last_progress_at: at(
											Math.max(
												2 * MIN,
												Math.min(130 * MIN, sinceMidnight - MIN),
											),
										),
									}
								: r,
						)
				: all;

	// decision D4: Claude Code / Codex sessions (made up: `demo/…` repos, `/Users/demo/…` folders)
	const MODEL: Record<Session["provider"], string> = {
		claude: "claude-opus-5-5",
		codex: "gpt-6-astra",
		ollama: "llama-4",
	};
	const session = (
		id: string,
		repo: string,
		status: Session["status"],
		agoMs: number,
		provider: Session["provider"] = "claude",
		model: string | null = MODEL[provider],
	): Session => ({
		id: `${provider}:demo-${id}`,
		provider,
		machine_id: "cockpit",
		repo_id: repo,
		cwd: `/Users/demo/work/${repo.split("/")[1] ?? "x"}`,
		branch: `feat/${id}-work`,
		model,
		status,
		started_at: at(agoMs + 20 * MIN),
		last_event_at: at(agoMs),
		ended_at: status === "ended" ? at(agoMs) : null,
		rev: 1,
	});
	const sessions: Session[] = [
		session("a", "demo/orchard", "active", 12_000),
		session("b", "demo/quill", "active", 40_000, "codex"),
		session("c", "demo/harbor", "waiting", 4 * MIN),
		session("d", "demo/ferry", "waiting", 52 * MIN),
		session("e", "demo/attic", "ended", 2 * HOUR),
		session("f", "demo/meadow", "idle", 8 * MIN, "claude", "claude-sonnet-5-5"),
		// quiet for 15 min and more: a dim 쉬는 중 row within 6 h, nothing after
		session("v", "demo/harbor", "stale", 2 * HOUR),
		session("w", "demo/ember", "stale", 7 * HOUR, "codex"),
	];
	if (kase === "busy")
		sessions.push(
			session(
				"g",
				"demo/orchard",
				"active",
				30_000,
				"claude",
				"claude-fable-5-2",
			),
			session("h", "demo/orchard", "active", 70_000, "codex"),
			session("i", "demo/orchard", "idle", 6 * MIN),
			session("j", "demo/orchard", "idle", 9 * MIN),
			session("k", "demo/meadow", "active", 20_000),
			session("l", "demo/meadow", "active", 90_000, "codex"),
			session("m", "demo/garnet", "active", 15_000),
			session("n", "demo/garnet", "waiting", 3 * MIN),
			session(
				"o",
				"demo/willow",
				"active",
				50_000,
				"claude",
				"claude-sonnet-5-5",
			),
			session("p", "demo/willow", "idle", 11 * MIN),
			session("q", "demo/beacon", "active", 25_000, "codex"),
			session("r", "demo/hollow", "idle", 12 * MIN),
			session("s", "demo/cinder", "active", 65_000),
			session("t", "demo/basalt", "idle", 13 * MIN),
			session("u", "demo/quarry", "active", 35_000),
		);
	if (kase === "calm")
		for (const s of sessions) if (s.status === "waiting") s.status = "idle";
	// done: the sessions of four projects (harbor's resting), so willow, the earlier finish, takes the
	// seventh lot — the one the reduced-motion plaza shot frames
	if (kase === "done") {
		sessions.splice(
			0,
			sessions.length,
			...sessions.filter((s) =>
				["demo/orchard", "demo/quill", "demo/meadow", "demo/harbor"].includes(
					s.repo_id ?? "",
				),
			),
		);
		for (const s of sessions) if (s.status === "waiting") s.status = "idle";
	}

	// the tails' events: what the hook sends (summaries with made-up absolute paths, which the panel
	// must show relative or cut to their last two parts)
	const events: Event[] = [];
	let seq = 0;
	const said = (
		s: Session,
		agoMs: number,
		type: string,
		tool: string | null,
		summary: string,
		agent: string | null = null,
	) =>
		events.push({
			id: `demo:${s.id}:${seq++}`,
			ts: at(agoMs),
			machine_id: "cockpit",
			session_id: s.id,
			agent_id: agent ?? s.id,
			provider: s.provider,
			type,
			tool,
			summary,
			repo_id: s.repo_id,
			payload_redacted: {},
		});
	let script = 0;
	for (const s of sessions) {
		if (s.status !== "active" && s.status !== "waiting") continue;
		const t = Date.parse(at(0)) - Date.parse(s.last_event_at);
		const cwd = `/Users/demo/work/${s.repo_id?.split("/")[1] ?? "x"}`;
		if (s.provider === "codex") {
			said(
				s,
				t + 40_000,
				"PreToolUse",
				"exec",
				'exec: text(await tools.exec_command({cmd:"bun test apps/web\nexit"}))',
			);
			said(
				s,
				t + 30_000,
				"PreToolUse",
				"exec",
				'exec: text(await tools.write_stdin({session_id:7,chars:""}))',
			);
			said(
				s,
				t + 20_000,
				"PreToolUse",
				"exec",
				`exec: text(await tools.exec_command({cmd:"rg -n TODO ${cwd}/src"}))`,
			);
			said(
				s,
				t,
				"PreToolUse",
				"exec",
				'exec: text(await tools.exec_command({cmd:"git diff --stat"}))',
			);
			continue;
		}
		said(s, t + 60_000, "UserPromptSubmit", null, "prompt (412 chars)");
		said(s, t + 50_000, "PreToolUse", "Read", `Read ${cwd}/src/board/model.ts`);
		// the command's prefix (`cd … &&`, `S=…`) goes; a heredoc or `-e` script shows as `<program> (스크립트)`
		said(s, t + 40_000, "PreToolUse", "Bash", `Bash: cd ${cwd} && bun test`);
		said(s, t + 35_000, "PreToolUse", "Bash", "Bash: bun test");
		// a subagent: still running in two sessions (`+1 sub`), finished in the others
		const sub = `${s.id}/sub:toolu_demo${seq}`;
		said(
			s,
			t + 30_000,
			"PreToolUse",
			"Agent",
			"Agent → reviewer: check the diff",
			sub,
		);
		if (!["claude:demo-a", "claude:demo-g"].includes(s.id))
			said(
				s,
				t + 20_000,
				"PostToolUse",
				"Agent",
				"Agent → reviewer: check the diff",
				sub,
			);
		said(s, t + 10_000, "PreToolUse", "Edit", `Edit ${cwd}/src/style.css`);
		if (s.status === "waiting")
			said(
				s,
				t,
				"Notification",
				null,
				"Claude needs your permission to use Bash",
			);
		else
			said(
				s,
				t,
				"PreToolUse",
				"Bash",
				[
					"Bash: python3 - <<'EOF'\nimport json\nprint(json.dumps({}))",
					"Bash: cat /Users/demo/Documents/notes/today.md && bun run lint",
					`Bash: S=${cwd}/tmp\nbun -e 'console.log(1)'`,
				][script++ % 3] as string,
			);
	}

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

	// done: the screen saw quarry finish 1.5 s before the page's time (visits.ts stepWatch would have)
	const quarry = currentRuns(runs).find((c) => c.project_id === "demo/quarry");
	const watch: Watch | undefined =
		kase === "done" && quarry
			? {
					...emptyWatch(),
					observed: [{ c: quarry, text: PASSED_TEXT, at: t0 - 1_500 }],
				}
			: undefined;

	return {
		...(watch ? { watch } : {}),
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
		sessions,
		events,
	};
}
