import { describe, expect, test } from "bun:test";
import type { Session } from "@agent-city/schema";
import { demoData } from "./demo.ts";
import { toVillageModel } from "./model.ts";
import { rowTag } from "./Sessions.tsx";
import {
	folderLabel,
	GROUP_CAP,
	type PanelInput,
	panelHeight,
	REST_SHOWN_MS,
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
const EMPTY_MODEL: PanelInput["model"] = {
	visits: [],
	now: [],
	paused: [],
	waitingSessions: [],
};

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
	test("active, waiting; idle and stale within 6 h (dim 쉬는 중, no tail); ended and older are hidden", () => {
		const p = panel([
			sess("o/a", "active", 10_000),
			sess("o/a", "waiting", 3 * HOUR),
			sess("o/a", "idle", 10 * MIN),
			// idle silent for 15 min turns stale by the screen's clock (applyStale, as the hub does): it stays
			sess("o/a", "idle", 2 * HOUR),
			// active but silent for 20 min: stale by the screen's clock, shown resting
			sess("o/a", "active", 20 * MIN),
			sess("o/a", "stale", 5 * HOUR),
			sess("o/a", "stale", 7 * HOUR),
			sess("o/a", "idle", 25 * HOUR),
			sess("o/a", "ended", MIN),
		]);
		const rows = p.groups[0]?.rows ?? [];
		expect(rows.map((r) => r.status)).toEqual(
			["waiting", "active", "idle", "stale", "stale", "stale"].slice(
				0,
				ROWS_PER_GROUP,
			),
		);
		expect(p.groups[0]?.more).toBe(6 - ROWS_PER_GROUP);
		expect(p.counts).toEqual({ active: 1, waiting: 1, idle: 4 });
		for (const r of rows)
			if (r.status === "idle" || r.status === "stale")
				expect([r.tail.length, r.subagents]).toEqual([0, 0]);
	});
	test("6 h boundary: a resting session shows just inside it and not at it", () => {
		const shown = (agoMs: number) =>
			panel([sess("o/a", "stale", agoMs)]).groups.length;
		expect(shown(REST_SHOWN_MS - 1000)).toBe(1);
		expect(shown(REST_SHOWN_MS)).toBe(0);
		expect(panel([sess("o/a", "ended", MIN)]).groups).toHaveLength(0);
	});
	test("resting rows sort last and fold first", () => {
		const p = panel([
			...Array.from({ length: 12 }, (_, i) =>
				sess(`o/r${i % 3}`, "stale", HOUR + i * MIN),
			),
			...Array.from({ length: 10 }, (_, i) =>
				sess(`o/w${i % 5}`, "active", 10_000 + i),
			),
		]);
		const kept = p.groups.flatMap((g) => g.rows);
		expect(kept.filter((r) => r.status === "active")).toHaveLength(10);
		expect(kept.length).toBeLessThanOrEqual(ROW_CAP);
		expect(p.groups[0]?.rows[0]?.status).toBe("active");
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
	test("a session outside any repo goes to 미지정 (or, since 16 A4-3, its folder's name)", () => {
		expect(
			panel([sess(null, "active", 1_000, { cwd: null })]).groups[0]?.label,
		).toBe("미지정");
		expect(panel([sess(null, "active", 1_000)]).groups[0]?.label).toBe("x");
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
			waitingSessions: [],
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

describe("waits after the HQ visit (model.waitingSessions)", () => {
	const late = (s: Session, sinceAgo: number) => ({
		id: `session:${s.id}`,
		project_id: s.repo_id ?? "",
		provider_label: "Claude",
		since: ago(sinceAgo),
	});
	test("dim with its wait; not 대기, not first; a fresh wait stays yellow and first", () => {
		const old = sess("o/old", "waiting", 40 * MIN);
		const fresh = sess("o/fresh", "waiting", 5 * MIN);
		const work = sess("o/work", "active", 10_000);
		const p = panel([old, fresh, work], {
			model: { ...EMPTY_MODEL, waitingSessions: [late(old, 42 * MIN)] },
		});
		expect(p.groups.map((g) => g.project_id)).toEqual([
			"o/fresh",
			"o/work",
			"o/old",
		]);
		const o = p.groups[2]?.rows[0];
		expect([o?.status, o?.waited_since]).toEqual(["waiting", ago(42 * MIN)]);
		expect(p.groups[0]?.rows[0]?.waited_since).toBeNull();
		expect(p.counts).toEqual({ active: 1, waiting: 1, idle: 0 });
	});
	test("in a group: 입력 대기 → 진행 → old wait → 쉬는 중; an old wait's tail folds before active ones", () => {
		const old = sess("o/a", "waiting", 50 * MIN);
		const rows = [
			sess("o/a", "idle", 2 * MIN),
			old,
			sess("o/a", "active", 10_000),
			sess("o/a", "waiting", 2 * MIN),
		];
		const model = { ...EMPTY_MODEL, waitingSessions: [late(old, 50 * MIN)] };
		const p = panel(rows, { model });
		expect(p.groups[0]?.rows.map((r) => r.id)).toEqual([
			rows[3]?.id,
			rows[2]?.id,
			old.id,
			rows[0]?.id,
		]);
		// room for one tail more than the fresh wait's and the active one's
		const tight = panel(rows, {
			model,
			budget: panelHeight(
				{
					groups: [
						{
							...(p.groups[0] as (typeof p.groups)[number]),
							rows: (p.groups[0]?.rows ?? []).map((r) =>
								r.id === old.id ? { ...r, tail: [] } : r,
							),
						},
					],
					moreGroups: 0,
					counts: p.counts,
				},
				1,
			),
		});
		const tails = tight.groups[0]?.rows.map((r) => r.tail.length);
		expect(tails).toEqual([3, 3, 0, 0]);
	});
});

describe("waits after the HQ visit, end to end (sessions.ts decides, read only)", () => {
	const t0 = Date.UTC(2026, 10, 11, 5);
	const fromDemo = (sessionWaitMs?: number) => {
		const d = demoData(t0);
		const now = t0 + 1_000;
		const model = toVillageModel({ ...d, now, conn: "open", sessionWaitMs });
		return sessionPanel({
			sessions: d.sessions,
			tails: new Map(),
			model,
			now,
			budget: Number.POSITIVE_INFINITY,
			ui: 1,
			tailMax: 3,
			shortModel,
		});
	};
	const waits = (p: ReturnType<typeof fromDemo>) =>
		p.groups
			.flatMap((g) => g.rows)
			.filter((r) => r.status === "waiting")
			.map((r) => [r.id, r.waited_since !== null]);
	test("the 52 min wait is past the 30 min visit (dim), the 4 min one is at the HQ (yellow)", () => {
		expect(waits(fromDemo())).toEqual([
			["claude:demo-c", false],
			["claude:demo-d", true],
		]);
		expect(fromDemo().counts.waiting).toBe(1);
	});
	test("`?session_wait=` moves the line: 60 min keeps both yellow, 0 makes both dim", () => {
		expect(waits(fromDemo(60 * MIN)).every(([, dim]) => !dim)).toBe(true);
		expect(fromDemo(60 * MIN).counts.waiting).toBe(2);
		expect(waits(fromDemo(0)).every(([, dim]) => dim)).toBe(true);
		expect(fromDemo(0).counts.waiting).toBe(0);
	});
	test("a wait older than the town's 7 days is an old wait too (never yellow)", () => {
		const p = panel([sess("o/a", "waiting", 8 * 24 * HOUR)]);
		expect(p.groups[0]?.rows[0]?.waited_since).toBe(ago(8 * 24 * HOUR));
		expect(p.counts.waiting).toBe(0);
	});
	test("tags: 입력 대기 (yellow), 입력 대기 · <wait> (dim), 쉬는 중 for idle and stale, none when active", () => {
		const r = (
			status: "active" | "waiting" | "idle" | "stale",
			w: string | null = null,
		) => rowTag({ status, waited_since: w }, NOW);
		expect(r("waiting")).toEqual({ text: "입력 대기", kind: "waiting" });
		expect(r("waiting", ago(42 * MIN))).toEqual({
			text: "입력 대기 · 42분",
			kind: "waited",
		});
		expect(r("waiting", ago(3 * HOUR))?.text).toBe("입력 대기 · 3시간");
		expect(r("idle")).toEqual({ text: "쉬는 중", kind: "idle" });
		expect(r("stale")).toEqual({ text: "쉬는 중", kind: "idle" });
		expect(r("active")).toBeNull();
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

describe("repo-less sessions by folder (16 A4-3)", () => {
	test("one dim group per folder, named by its last name; no folder or a home folder: 미지정", () => {
		const p = panel([
			sess(null, "active", 1_000, { cwd: "/Users/demo/work/scratchpad" }),
			sess(null, "active", 2_000, { cwd: "/Users/demo/work/scratchpad" }),
			sess(null, "idle", 3_000, { cwd: "/tmp/try-out" }),
			sess(null, "active", 4_000, { cwd: "/Users/demo" }),
			sess(null, "active", 5_000, { cwd: null }),
			sess("o/a", "active", 6_000, { cwd: "/Users/demo/work/a" }),
		]);
		const groups = p.groups.map((g) => [
			g.label,
			g.unassigned ?? false,
			g.rows.length,
		]);
		expect(groups).toContainEqual(["scratchpad", true, 2]);
		expect(groups).toContainEqual(["try-out", true, 1]);
		expect(groups).toContainEqual(["미지정", true, 2]);
		expect(groups).toContainEqual(["a", false, 1]);
		// the user's name never becomes a label
		expect(p.groups.some((g) => g.label === "demo")).toBe(false);
	});

	test("folderLabel: never a home folder or above, never a secret-looking name, at most 40 characters", () => {
		expect(folderLabel("/Users/demo/work/orchard")).toBe("orchard");
		expect(folderLabel("/Users/demo/work/orchard/")).toBe("orchard");
		expect(folderLabel("C:\\Users\\demo\\proj")).toBe("proj");
		for (const home of [
			"/Users/demo",
			"/Users/demo/",
			"/home/demo",
			"C:\\Users\\demo",
			"~",
			"~demo",
			"/",
			"",
			null,
		])
			expect(folderLabel(home)).toBeNull();
		const fake = ["ghp_", "a".repeat(36)].join("");
		expect(folderLabel(`/tmp/${fake}`)).toBeNull();
		expect(folderLabel(`/tmp/${"x".repeat(60)}`)?.length).toBe(40);
	});
});
