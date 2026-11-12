import { describe, expect, test } from "bun:test";
import type { Session } from "@agent-city/schema";
import { demoData } from "./demo.ts";
import { toVillageModel } from "./model.ts";
import {
	GROUP_CAP,
	type PanelInput,
	panelHeight,
	ROW_CAP,
	ROWS_PER_GROUP,
	sessionPanel,
	TAIL_CAP,
} from "./session-panel.ts";
import { shortModel, type TailLine } from "./tail.ts";

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

let n = 0;
const sess = (
	repo: string | null,
	status: Session["status"],
	agoMs: number,
	over: Partial<Session> = {},
): Session => ({
	id: `claude:t${n++}`,
	provider: "claude",
	machine_id: "cockpit",
	repo_id: repo,
	cwd: "/Users/demo/work/x",
	branch: "main",
	model: "claude-opus-5-5",
	status,
	started_at: ago(agoMs + HOUR),
	last_event_at: ago(agoMs),
	ended_at: null,
	rev: 1,
	...over,
});
const lines = (k: number): TailLine[] =>
	Array.from({ length: k }, (_, i) => ({ text: `$ step ${i}`, count: 1 }));
const EMPTY_MODEL: PanelInput["model"] = { visits: [], now: [], paused: [] };

const panel = (sessions: Session[], over: Partial<PanelInput> = {}) =>
	sessionPanel({
		sessions,
		tails: new Map(
			sessions.map((s) => [s.id, { lines: lines(3), subagents: 2 }]),
		),
		model: EMPTY_MODEL,
		now: NOW,
		budget: Number.POSITIVE_INFINITY,
		ui: 1,
		tailMax: 3,
		shortModel,
		...over,
	});

describe("which sessions show (15 §3)", () => {
	test("active, waiting and idle within 24 h; stale, ended and older idle are hidden", () => {
		const p = panel([
			sess("o/a", "active", 10_000),
			sess("o/a", "waiting", 3 * HOUR),
			sess("o/a", "idle", 10 * MIN),
			// idle silent for 15 min turns stale by the screen's clock (applyStale, as the hub does)
			sess("o/a", "idle", 23 * HOUR),
			sess("o/a", "idle", 25 * HOUR),
			sess("o/a", "ended", MIN),
			sess("o/a", "stale", MIN),
			// active but silent for 20 min: stale by the screen's clock (applyStale), hidden
			sess("o/a", "active", 20 * MIN),
		]);
		expect(p.groups[0]?.rows.map((r) => r.status)).toEqual([
			"waiting",
			"active",
			"idle",
		]);
		expect(p.counts).toEqual({ active: 1, waiting: 1, idle: 1 });
	});
	test("a session row: provider · short model; tails only under active and waiting", () => {
		const p = panel([
			sess("o/a", "active", 10_000),
			sess("o/a", "idle", 5 * MIN, { model: null, provider: "codex" }),
		]);
		const [a, i] = p.groups[0]?.rows ?? [];
		expect([a?.provider, a?.model, a?.tail.length, a?.subagents]).toEqual([
			"Claude",
			"opus 5.5",
			3,
			2,
		]);
		expect([i?.provider, i?.model, i?.tail.length, i?.subagents]).toEqual([
			"Codex",
			null,
			0,
			0,
		]);
	});
	test("a session outside any repo goes to 미지정", () => {
		const p = panel([sess(null, "active", 1_000)]);
		expect(p.groups[0]?.label).toBe("미지정");
	});
	test("tails: 2 lines on a screen under 1600 px", () => {
		const p = panel([sess("o/a", "active", 1_000)], { tailMax: 2 });
		expect(p.groups[0]?.rows[0]?.tail.map((l) => l.text)).toEqual([
			"$ step 1",
			"$ step 2",
		]);
	});
});

describe("groups: order and tags", () => {
	test("결재 / 입력 대기 first, then working, then the most recent; a run's state is the tag, else the branch", () => {
		const sessions = [
			sess("o/idle", "idle", 10 * MIN, { branch: "feat/x" }),
			sess("o/busy", "active", 5 * MIN, {}),
			sess("o/ask", "waiting", 3 * HOUR),
		];
		const model: PanelInput["model"] = {
			visits: [
				{
					id: "cockpit:r1",
					kind: "sign",
					project_id: "o/sign",
					carry: "folder",
					text: "작업을 마쳤습니다. 통합 확인 부탁드립니다.",
					code: "AWAITING_OWNER_INTEGRATION",
					since: ago(6 * HOUR),
					until: null,
					closing: false,
					starts: ago(6 * HOUR),
				},
			],
			now: [
				{
					kind: "run",
					key: "cockpit:r2",
					project_id: "o/run",
					workflow_id: "w",
					phase: "Independent Review",
					phase_label: "리뷰",
					phase_index: 5,
					display: "running",
					reported_at: ago(MIN),
					machine_id: "cockpit",
					tokens_today: null,
					usage_unknown: false,
					stale: false,
				},
			],
			paused: [{ key: "cockpit:r3", project_id: "o/rest", since: ago(HOUR) }],
		};
		const p = panel(sessions, { model });
		expect(p.groups.map((g) => [g.label, g.tag?.text, g.tag?.kind])).toEqual([
			["ask", "main", "branch"],
			["sign", "통합 대기", "wait"],
			["run", "리뷰 중", "run"],
			["busy", "main", "branch"],
			["idle", "feat/x", "branch"],
			["rest", "쉬는 중", "pause"],
		]);
		expect(p.groups.find((g) => g.label === "run")?.phase).toBe(5);
		expect(p.groups.find((g) => g.label === "sign")?.rows).toEqual([]);
	});
});

describe("caps and folds", () => {
	test("at most 4 rows a group (외 N), 16 in all, 8 groups (외 N곳), 6 tails", () => {
		const sessions: Session[] = [];
		for (let g = 0; g < 10; g++)
			for (let i = 0; i < 5; i++)
				sessions.push(sess(`o/p${g}`, "active", (g * 5 + i) * 1_000));
		const p = panel(sessions);
		expect(p.groups).toHaveLength(GROUP_CAP);
		expect(p.moreGroups).toBe(2);
		for (const g of p.groups)
			expect(g.rows.length).toBeLessThanOrEqual(ROWS_PER_GROUP);
		const rows = p.groups.flatMap((g) => g.rows);
		expect(rows).toHaveLength(ROW_CAP);
		expect(rows.filter((r) => r.tail.length).length).toBe(TAIL_CAP);
		// every folded row is counted
		expect(p.groups.reduce((s, g) => s + g.rows.length + g.more, 0)).toBe(
			GROUP_CAP * 5,
		);
		expect(p.counts.active).toBe(50);
	});
	test("tails fold the oldest active first; waiting tails stay", () => {
		const sessions = [
			sess("o/a", "waiting", 50 * MIN),
			...Array.from({ length: 7 }, (_, i) =>
				sess(`o/b${i}`, "active", (i + 1) * 1_000),
			),
		];
		const p = panel(sessions);
		const withTail = p.groups
			.flatMap((g) => g.rows)
			.filter((r) => r.tail.length);
		expect(withTail).toHaveLength(TAIL_CAP);
		expect(withTail.some((r) => r.status === "waiting")).toBe(true);
		// the two oldest active ones lost theirs
		const folded = p.groups
			.flatMap((g) => g.rows)
			.filter((r) => r.status === "active" && !r.tail.length)
			.map((r) => r.last_event_at);
		expect(folded).toEqual([ago(7_000), ago(6_000)].sort().reverse());
	});
	test("rows fold idle first, a waiting row last", () => {
		const sessions = [
			...Array.from({ length: 4 }, (_, g) => [
				sess(`o/g${g}`, "waiting", MIN),
				sess(`o/g${g}`, "active", 2 * MIN),
				sess(`o/g${g}`, "idle", 5 * MIN),
				sess(`o/g${g}`, "idle", 6 * MIN),
			]).flat(),
			sess("o/g4", "waiting", MIN),
		];
		const p = panel(sessions);
		const rows = p.groups.flatMap((g) => g.rows);
		expect(rows).toHaveLength(ROW_CAP);
		expect(rows.filter((r) => r.status === "waiting")).toHaveLength(5);
		expect(rows.filter((r) => r.status === "active")).toHaveLength(4);
	});
	test("it fits the height budget: tails go first, then rows, then groups; never over", () => {
		const sessions = Array.from({ length: 12 }, (_, i) =>
			sess(`o/p${i % 6}`, i % 4 === 0 ? "waiting" : "active", i * 1_000),
		);
		for (const budget of [900, 500, 300, 160, 60]) {
			for (const ui of [1, 1.15, 1.3]) {
				const p = panel(sessions, { budget, ui });
				expect(panelHeight(p, ui)).toBeLessThanOrEqual(budget);
			}
		}
		const roomy = panel(sessions, { budget: 900 });
		const tight = panel(sessions, { budget: 300 });
		const tails = (p: typeof roomy) =>
			p.groups.flatMap((g) => g.rows).filter((r) => r.tail.length).length;
		expect(tails(tight)).toBeLessThan(tails(roomy));
		// waiting rows outlast the active ones when the rows fold
		const small = panel(sessions, { budget: 160 });
		const kept = small.groups.flatMap((g) => g.rows);
		expect(kept.every((r) => r.status === "waiting")).toBe(true);
	});
});

describe("the demo's cases (?demo=1&case=…)", () => {
	const t0 = Date.UTC(2026, 10, 11, 5);
	test("calm: nothing waits for the owner", () => {
		const d = demoData(t0, "calm");
		const m = toVillageModel({ ...d, now: t0 + 1_000, conn: "open" });
		expect(m.visits.filter((v) => v.kind === "sign")).toHaveLength(0);
		expect(m.status.border).toBe("none");
	});
	test("busy: more than the caps, and tails with absolute paths for the check to catch", () => {
		const d = demoData(t0, "busy");
		expect(d.sessions.length).toBeGreaterThan(ROW_CAP);
		expect(
			d.events.some((e) => (e.summary ?? "").includes("/Users/demo/")),
		).toBe(true);
		for (const s of d.sessions)
			expect(s.repo_id?.startsWith("demo/")).toBe(true);
	});
});
