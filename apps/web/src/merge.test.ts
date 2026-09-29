// Runs under `bun test`; excluded from the web tsconfig (DOM/vite types, no bun types).
import { describe, expect, test } from "bun:test";
import type { Event, Session } from "@agent-city/schema";
import { mergeEvents, mergeSessions } from "./merge.ts";

const T = (s: number) => `2026-09-29T00:00:${String(s).padStart(2, "0")}.000Z`;
const session = (
	status: Session["status"],
	last: number,
	id = "claude:s",
): Session => ({
	id,
	provider: "claude",
	machine_id: "cockpit",
	repo_id: null,
	cwd: null,
	branch: null,
	model: null,
	status,
	started_at: T(0),
	last_event_at: T(last),
	ended_at: null,
});

describe("F12 mergeSessions", () => {
	test("an older snapshot never overwrites a newer live update (audit probe)", () => {
		const merged = mergeSessions([session("active", 3)], [session("idle", 1)]);
		expect(merged).toEqual([session("active", 3)]);
	});

	test("a newer copy wins", () => {
		expect(mergeSessions([session("active", 1)], [session("idle", 3)])).toEqual(
			[session("idle", 3)],
		);
	});

	test("same last_event_at → incoming server copy wins (stale sweep)", () => {
		expect(
			mergeSessions([session("active", 2)], [session("stale", 2)]),
		).toEqual([session("stale", 2)]);
	});

	test("unknown ids are added, others kept", () => {
		const merged = mergeSessions(
			[session("active", 1, "claude:a")],
			[session("idle", 1, "codex:b")],
		);
		expect(merged.map((s) => s.id).sort()).toEqual(["claude:a", "codex:b"]);
	});
});

describe("mergeEvents", () => {
	const ev = (id: string, s: number) => ({ id, ts: T(s) }) as Event;
	test("newest first, unique by id, capped", () => {
		const a = [ev("1", 1), ev("2", 2)];
		const b = [ev("2", 2), ev("3", 3)];
		expect(mergeEvents(a, b).map((e) => e.id)).toEqual(["3", "2", "1"]);
		expect(mergeEvents(a, b, 2).map((e) => e.id)).toEqual(["3", "2"]);
	});
});
