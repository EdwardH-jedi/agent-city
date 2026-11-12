import { describe, expect, test } from "bun:test";
import { TAIL_MAX } from "./tail.ts";
import {
	endedSessions,
	MEMORY_SESSIONS,
	type MemEvent,
	stepTailMemory,
	type TailMemory,
	tailsWithSubagents,
} from "./tail-memory.ts";

// made-up sessions and folders only
const T0 = Date.UTC(2026, 10, 13, 1, 0, 0);
let seq = 0;
const ev = (
	session: string,
	summary: string,
	over: Partial<MemEvent> = {},
): MemEvent => {
	const k = seq++;
	return {
		id: `e${k}`,
		session_id: session,
		agent_id: session,
		type: "PreToolUse",
		tool: "Bash",
		summary: `Bash: ${summary}`,
		ts: new Date(T0 + k * 1000).toISOString(),
		...over,
	};
};
const NONE = new Set<string>();
const noCwd = () => null;
const step = (
	prev: TailMemory,
	events: MemEvent[],
	ended: ReadonlySet<string> = NONE,
	cwdOf: (id: string) => string | null = noCwd,
) => stepTailMemory(prev, events, ended, cwdOf);
/** The newest `n` events, newest first (what useHub holds). */
const window = (all: MemEvent[], n = 200) =>
	[...all].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, n);
const texts = (m: TailMemory, id: string) =>
	m.get(id)?.map((l) => (l.count > 1 ? `${l.text} ×${l.count}` : l.text));

describe("tail memory (REVIEW 2026-11-13 #3)", () => {
	test("idempotent: the same window twice changes nothing (no doubled lines or ×N)", () => {
		const all = [ev("a", "ls"), ev("a", "ls"), ev("a", "git status")];
		const once = step(new Map(), window(all));
		const twice = step(once, window(all));
		expect(twice).toBe(once);
		expect(texts(twice, "a")).toEqual(["$ ls ×2", "$ git status"]);
	});
	test("a quiet session's lines survive 300 events of a busy one", () => {
		const all = [ev("a", "make a"), ev("a", "make b"), ev("a", "make c")];
		let m = step(new Map(), window(all));
		for (let i = 0; i < 300; i++) {
			all.push(ev("b", `step ${i}`));
			m = step(m, window(all));
		}
		expect(window(all).some((e) => e.session_id === "a")).toBe(false);
		expect(texts(m, "a")).toEqual(["$ make a", "$ make b", "$ make c"]);
		expect(texts(m, "b")).toEqual(["$ step 297", "$ step 298", "$ step 299"]);
	});
	test("a run cut by the window's edge keeps counting", () => {
		const all = [ev("a", "make x")];
		for (let i = 0; i < 4; i++) all.push(ev("a", "bun test"));
		let m = step(new Map(), window(all));
		expect(texts(m, "a")).toEqual(["$ make x", "$ bun test ×4"]);
		// the window now holds only the last two `bun test` and one more
		all.push(ev("a", "bun test"));
		for (let i = 0; i < 197; i++) all.push(ev("b", `n ${i}`));
		m = step(m, window(all));
		expect(texts(m, "a")).toEqual(["$ make x", "$ bun test ×5"]);
		expect(step(m, window(all))).toBe(m);
	});
	test("an event that arrives late still lands in its place", () => {
		const pre = ev("a", "ls");
		const post = ev("a", "", { type: "PostToolUse", summary: "Bash done" });
		const pwd = ev("a", "pwd");
		// the PostToolUse and a newer line come first; the older PreToolUse after them
		let m = step(new Map(), [pwd, post]);
		expect(texts(m, "a")).toEqual(["$ pwd"]);
		m = step(m, [pwd, post, pre]);
		expect(texts(m, "a")).toEqual(["$ ls", "$ pwd"]);
		// a snapshot with older events landing after a live one
		const live = ev("c", "make");
		const old = {
			...ev("c", "cat a.md"),
			ts: new Date(T0 - 5000).toISOString(),
		};
		m = step(m, [live]);
		m = step(m, [live, old]);
		expect(texts(m, "c")).toEqual(["$ cat a.md", "$ make"]);
	});
	test("lines still in the window follow the session's folder as it is now", () => {
		const all = [ev("a", "cat /Users/demo/work/x/src/a.ts")];
		let m = step(new Map(), window(all));
		expect(texts(m, "a")).toEqual(["$ cat …/src/a.ts"]);
		m = step(m, window(all), NONE, () => "/Users/demo/work/x");
		expect(texts(m, "a")).toEqual(["$ cat ./src/a.ts"]);
	});
	test("bounded: 200 sessions over a night leave at most 64 entries of at most 3 lines (the newest kept)", () => {
		let m: TailMemory = new Map();
		const all: MemEvent[] = [];
		for (let s = 0; s < 200; s++)
			for (let i = 0; i < 5; i++) {
				all.push(ev(`s${s}`, `cmd ${i}`));
				m = step(m, window(all));
				expect(m.size).toBeLessThanOrEqual(MEMORY_SESSIONS);
			}
		expect(m.size).toBe(MEMORY_SESSIONS);
		for (const lines of m.values())
			expect(lines.length).toBeLessThanOrEqual(TAIL_MAX);
		expect(m.has("s199")).toBe(true);
		expect(m.has("s0")).toBe(false);
	});
	test("ended sessions are dropped and stay gone on the next step", () => {
		const all = [ev("a", "ls"), ev("b", "pwd")];
		let m = step(new Map(), window(all));
		const ended = endedSessions([{ id: "a", status: "ended" }], window(all));
		m = step(m, window(all), ended);
		expect(m.has("a")).toBe(false);
		m = step(m, window(all), ended);
		expect(m.has("a")).toBe(false);
		// a SessionEnd as the newest event in the window ends it too
		all.push(ev("b", "", { type: "SessionEnd", tool: null, summary: "end" }));
		const ended2 = endedSessions([], window(all));
		expect([...ended2]).toEqual(["b"]);
		m = step(m, window(all), ended2);
		expect(m.has("b")).toBe(false);
	});
	test("only finished lines and their times are kept (redacted, no absolute path), never events", () => {
		const m = step(new Map(), [
			ev("a", "cat /Users/demo/notes/x.md"),
			ev("a", "", { type: "PostToolUse", summary: "Bash done" }),
		]);
		const lines = m.get("a") ?? [];
		expect(Object.keys(lines[0] ?? {}).sort()).toEqual([
			"count",
			"first",
			"last",
			"text",
		]);
		expect(JSON.stringify(lines)).not.toContain("/Users/");
	});
	test("subagents still come from the window", () => {
		const sub = ev("a", "", {
			tool: "Agent",
			agent_id: "a/sub:t1",
			summary: "Agent → reviewer: look",
		});
		const m = step(new Map(), [sub]);
		expect(tailsWithSubagents(m, [sub]).get("a")?.subagents).toBe(1);
		expect(tailsWithSubagents(m, []).get("a")).toEqual({
			lines: [{ text: "→ reviewer: look", count: 1 }],
			subagents: 0,
		});
	});
});
