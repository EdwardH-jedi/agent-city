// Decision D4: Claude Code / Codex sessions in the village. Fake clock throughout.
import { describe, expect, test } from "bun:test";
import { toCampusModel } from "../campus/presentation.ts";
import { iso, machine, run, screen, session, T0 } from "./fixtures.ts";
import { toVillageModel, WINDOW_CAP } from "./model.ts";
import {
	parseSessionWait,
	SESSION_RECENT_MS,
	sessionClock,
} from "./sessions.ts";

const S = 1_000;
/** The fixture clock is 05:00 in the test time zone (UTC), inside the default quiet hours. */
const LOUD = "?quiet=off";
const MIN = 60 * S;
const machines = [machine("online")];
const base = { machines, districts: {}, eventsByRun: new Map(), runs: [] };
const model = (sessions: ReturnType<typeof session>[], over = {}) =>
	toVillageModel({ ...base, sessions, now: T0, conn: "open", ...over });

/** A session that started waiting at T0 + `atMs` (its last event is the Notification). */
const waitingAt = (atMs: number, over = {}) =>
	session({ status: "waiting", last_event_at: iso(atMs), ...over });

describe("?session_wait= (minutes; 0 = off)", () => {
	test("default 30, a number of minutes, 0, and anything else keeps the default", () => {
		expect(parseSessionWait("")).toBe(30 * MIN);
		expect(parseSessionWait("?session_wait=30")).toBe(30 * MIN);
		expect(parseSessionWait("?session_wait=45")).toBe(45 * MIN);
		expect(parseSessionWait("?session_wait=0")).toBe(0);
		for (const bad of [
			"?session_wait=",
			"?session_wait=-1",
			"?session_wait=x",
			"?session_wait=1.5",
		])
			expect(parseSessionWait(bad)).toBe(30 * MIN);
	});
});

describe("D4 · a session waiting for input visits the HQ", () => {
	test("under 60 s: nothing; at 60 s: visit `session:<id>`, the sentence, a folder, yellow, one knock", () => {
		const s = screen(LOUD);
		s.step(T0, { ...base, sessions: [session()] });
		const w = [waitingAt(5 * S)];
		for (const t of [5, 30, 64]) {
			const r = s.step(T0 + t * S, { ...base, sessions: w });
			expect(r.model.visits).toEqual([]);
			expect(r.model.status.border).toBe("none");
			expect(r.model.waitingSessions).toEqual([]);
			expect(r.cues).toEqual([]);
		}
		const r = s.step(T0 + 65 * S, { ...base, sessions: w });
		expect(r.model.visits).toEqual([
			{
				id: "session:claude:fake-session-1",
				kind: "sign",
				project_id: "acme/widgets",
				carry: "folder",
				text: "입력을 기다리고 있습니다.",
				code: null,
				since: iso(5 * S),
				until: null,
				closing: false,
				starts: iso(65 * S),
			},
		]);
		expect(r.model.status.border).toBe("yellow");
		expect(r.model.status.sentence).toBe("입력 대기 1건");
		expect(r.cues).toEqual(["knock"]);
	});

	test("30 min after the wait began the visit ends and the session moves to the quiet list", () => {
		const s = screen(LOUD);
		const w = [waitingAt(0)];
		s.step(T0, { ...base, sessions: w });
		const knocks: string[] = [];
		for (let t = 1; t < 30 * 60; t += 15) {
			const r = s.step(T0 + t * S, { ...base, sessions: w });
			knocks.push(...r.cues);
			if (t >= 60) expect(r.model.visits).toHaveLength(1);
		}
		expect(knocks).toEqual(["knock"]);
		const last = s.step(T0 + 30 * MIN - S, { ...base, sessions: w });
		expect(last.model.visits).toHaveLength(1);
		const moved = s.step(T0 + 30 * MIN, { ...base, sessions: w });
		expect(moved.model.visits).toEqual([]);
		expect(moved.model.status.border).toBe("none");
		expect(moved.model.status.sentence).toBe("전부 정상");
		expect(moved.model.waitingSessions).toEqual([
			{
				id: "session:claude:fake-session-1",
				project_id: "acme/widgets",
				provider_label: "Claude",
				since: iso(0),
			},
		]);
		expect(moved.cues).toEqual([]);
	});

	test("one knock only: `?session_wait=45` does not knock again at 30 min (no reminder for sessions)", () => {
		const s = screen(`${LOUD}&session_wait=45`);
		const w = [waitingAt(0)];
		const cues: string[] = [];
		s.step(T0, { ...base, sessions: w });
		for (let t = 1; t <= 50 * 60; t += 10)
			cues.push(...s.step(T0 + t * S, { ...base, sessions: w }).cues);
		expect(cues).toEqual(["knock"]);
	});

	test("`?session_wait=0`: no visit and no knock, ever; the session is in the list after 60 s", () => {
		const s = screen(`${LOUD}&session_wait=0`);
		const w = [waitingAt(0)];
		const cues: string[] = [];
		s.step(T0, { ...base, sessions: w });
		for (let t = 1; t <= 40 * 60; t += 10) {
			const r = s.step(T0 + t * S, {
				...base,
				sessions: w,
				sessionWaitMs: parseSessionWait("?session_wait=0"),
			});
			cues.push(...r.cues);
			expect(r.model.visits).toEqual([]);
			expect(r.model.status.border).toBe("none");
			expect(r.model.waitingSessions).toHaveLength(t >= 60 ? 1 : 0);
		}
		expect(cues).toEqual([]);
	});

	test("an event that keeps it waiting does not restart the 60 s, the walk or the knock", () => {
		const s = screen(LOUD);
		s.step(T0, { ...base, sessions: [waitingAt(0)] });
		const at70 = s.step(T0 + 70 * S, { ...base, sessions: [waitingAt(0)] });
		expect(at70.model.visits[0]?.since).toBe(iso(0));
		// a second Notification at 80 s bumps last_event_at; still waiting
		const bumped = [waitingAt(80 * S, { rev: 2 })];
		for (const t of [80, 81, 100, 139, 200]) {
			const r = s.step(T0 + t * S, { ...base, sessions: bumped });
			expect(r.model.visits.map((v) => [v.id, v.since])).toEqual([
				["session:claude:fake-session-1", iso(0)],
			]);
			expect(r.cues).toEqual([]);
		}
	});

	test("back to work ends the visit at once; a new wait later counts 60 s again and knocks again", () => {
		const s = screen(LOUD);
		s.step(T0, { ...base, sessions: [waitingAt(0)] });
		expect(
			s.step(T0 + 61 * S, { ...base, sessions: [waitingAt(0)] }).cues,
		).toEqual(["knock"]);
		const busy = s.step(T0 + 62 * S, {
			...base,
			sessions: [session({ status: "active", last_event_at: iso(62 * S) })],
		});
		expect(busy.model.visits).toEqual([]);
		s.step(T0 + 100 * S, { ...base, sessions: [waitingAt(100 * S)] });
		expect(
			s.step(T0 + 159 * S, { ...base, sessions: [waitingAt(100 * S)] }).model
				.visits,
		).toEqual([]);
		expect(
			s.step(T0 + 160 * S, { ...base, sessions: [waitingAt(100 * S)] }).cues,
		).toEqual(["knock"]);
	});

	test("cockpit offline: session visits freeze where they were and nothing sounds", () => {
		const s = screen(LOUD);
		const beat = T0 + 70 * S; // last heartbeat
		const off = [
			{
				...machine("offline"),
				heartbeat_at: new Date(beat).toISOString(),
			},
		];
		// the clock stops when the cockpit stops counting as online (last beat + 90 s = T0 + 160 s): one
		// session visiting by then, one that began waiting only 30 s before it
		const a = waitingAt(0, { id: "claude:fake-a" });
		const b = waitingAt(130 * S, {
			id: "claude:fake-b",
			repo_id: "acme/gears",
		});
		// online, ticking: `a` reaches its 60 s at T0 + 60 s (the last beat is at T0 + 70 s)
		for (const t of [0, 30, 60, 70])
			s.step(T0 + t * S, {
				...base,
				machines: [{ ...machine("online"), heartbeat_at: iso(t * S) }],
				sessions: [a],
			});
		const cues: string[] = [];
		for (const t of [5 * 60, 20 * 60, 45 * 60, 3 * 60 * 60]) {
			const r = s.step(T0 + t * S, {
				...base,
				machines: off,
				sessions: [a, b],
			});
			cues.push(...r.cues);
			expect(r.model.status.dim).toBe(true);
			expect(r.model.visits.map((v) => v.id)).toEqual([
				"session:claude:fake-a",
			]);
			expect(r.model.waitingSessions).toEqual([]);
		}
		expect(cues).toEqual([]);
		expect(sessionClock("cockpit", off, T0 + 3_600 * S)).toBe(beat + 90 * S);
		// never backwards: as the machine turns stale the clock is still `now` up to beat + 90 s
		const stale = [{ ...off[0], status: "stale" as const }];
		expect(sessionClock("cockpit", stale, beat + 80 * S)).toBe(beat + 80 * S);
		// a forge session stops too while the cockpit is offline (Q4: cockpit offline stops session visits)
		expect(
			sessionClock(
				"forge",
				[...off, machine("online", "forge")],
				T0 + 3_600 * S,
			),
		).toBe(beat + 90 * S);
		expect(sessionClock("cockpit", machines, T0)).toBe(T0);
		expect(sessionClock("cockpit", [machine("unobserved")], T0)).toBe(T0);
	});
});

describe("D3 · the 3D lead sets off when the visit starts, not when the wait began", () => {
	test("a sign's walk is anchored 60 s after its state began; a report's at its event", () => {
		const m = model([waitingAt(-5 * MIN)]);
		const scene = toCampusModel(m);
		expect(m.visits[0]?.since).toBe(iso(-5 * MIN));
		expect(scene.visitors[0]?.created_at).toBe(iso(-5 * MIN + 60 * S));
	});
});

describe("D4 · buildings, lights and 지금 진행", () => {
	test("a session active in the last 7 days raises its repo's building; older ones raise none", () => {
		const m = model([
			session({
				id: "claude:a",
				repo_id: "acme/fresh",
				last_event_at: iso(-6 * 24 * 3_600_000),
			}),
			session({
				id: "claude:b",
				repo_id: "acme/old",
				status: "ended",
				last_event_at: iso(-SESSION_RECENT_MS),
			}),
			session({
				id: "claude:c",
				repo_id: "local/scratch",
				status: "idle",
				last_event_at: iso(-60_000),
			}),
		]);
		const shown = m.village.shown.map((p) => p.label).sort();
		expect(shown).toEqual(["fresh", "scratch"]);
		expect(m.projects.find((p) => p.id === "acme/old")).toBeUndefined();
	});

	test("idle, stale, ended and waiting light nothing; only active does", () => {
		const m = model([
			session({ id: "claude:a", status: "idle" }),
			session({ id: "claude:b", status: "ended" }),
			session({ id: "claude:c", status: "stale" }),
			session({ id: "claude:d", status: "waiting" }),
			// reported active but silent for 15 min: stale by this screen's clock
			session({
				id: "claude:e",
				status: "active",
				last_event_at: iso(-15 * MIN),
			}),
		]);
		const p = m.village.shown[0];
		expect(p?.monitors).toEqual([]);
		expect(p?.sessions).toBe(0);
		expect(m.now).toEqual([]);
		const lit = model([session({ status: "active" })]).village.shown[0];
		expect(lit?.monitors).toEqual(["code"]);
	});

	test("windows lit = running runs + active sessions, at most 4 (2D and 3D)", () => {
		const runs = [1, 2, 3].map((i) =>
			run({ run_id: `r-${i}`, workflow_id: `w-${i}` }),
		);
		const sessions = [1, 2, 3].map((i) => session({ id: `claude:s-${i}` }));
		const m = toVillageModel({
			...base,
			runs,
			sessions,
			now: T0,
			conn: "open",
		});
		const p = m.village.shown[0];
		expect(p?.running).toBe(3);
		expect(p?.sessions).toBe(3);
		expect(p?.monitors).toHaveLength(WINDOW_CAP);
		expect(WINDOW_CAP).toBe(4);
		const campus = toCampusModel(m).repos[0];
		expect(campus?.monitors).toHaveLength(4);
		expect(campus?.active_tasks).toBe(4);
		// one session alone lights one window and the building glows
		const one = toCampusModel(model([session()])).repos[0];
		expect(one?.active_tasks).toBe(1);
	});

	test("the 8-building cap still holds with sessions", () => {
		const sessions = Array.from({ length: 12 }, (_, i) =>
			session({ id: `claude:s-${i}`, repo_id: `acme/repo-${i}` }),
		);
		const m = model(sessions);
		expect(m.village.shown).toHaveLength(8);
		expect(m.village.folded).toBe(4);
	});

	test("지금 진행: an active session is one line `프로젝트 · Claude` with its age, no phase bar", () => {
		const m = model([
			session({ id: "codex:x", provider: "codex", last_event_at: iso(-3_000) }),
			session({
				id: "claude:y",
				repo_id: "acme/gears",
				last_event_at: iso(-12_000),
			}),
		]);
		expect(
			m.now.map((n) => [
				n.kind,
				n.project_id,
				n.phase_label,
				n.phase_index,
				n.reported_at,
			]),
		).toEqual([
			["session", "acme/widgets", "Codex", -1, iso(-3_000)],
			["session", "acme/gears", "Claude", -1, iso(-12_000)],
		]);
		expect(m.today.running).toBe(2);
	});

	test("runs come first in 지금 진행, then sessions", () => {
		const m = toVillageModel({
			...base,
			runs: [run()],
			sessions: [session()],
			now: T0,
			conn: "open",
		});
		expect(m.now.map((n) => n.kind)).toEqual(["run", "session"]);
	});

	test("a session outside a checkout (no repo) raises no building but still shows in 지금 진행", () => {
		const m = model([session({ repo_id: null })]);
		expect(m.village.shown).toEqual([]);
		expect(m.now.map((n) => n.project_id)).toEqual(["(none)"]);
	});

	test("D5: no working folder, branch or model string reaches the board model", () => {
		const m = model([
			session({ status: "active" }),
			waitingAt(-5 * MIN, { id: "claude:w" }),
			waitingAt(-50 * MIN, { id: "claude:v" }),
		]);
		const dump = JSON.stringify(m);
		expect(dump).not.toContain("/home/someone");
		expect(dump).not.toContain("secret-branch-name");
		expect(m.visits).toHaveLength(1);
		expect(m.waitingSessions).toHaveLength(1);
	});
});
