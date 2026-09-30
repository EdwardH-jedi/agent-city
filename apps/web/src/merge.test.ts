// Runs under `bun test`; excluded from the web tsconfig (DOM/vite types, no bun types).
import { describe, expect, test } from "bun:test";
import type { Event, Session } from "@agent-city/schema";
import {
	liveCountByRepo,
	mergeEvents,
	mergeSessions,
	parseHubMessage,
} from "./merge.ts";

const T = (s: number) => `2026-09-29T00:00:${String(s).padStart(2, "0")}.000Z`;
const session = (
	status: Session["status"],
	rev: number,
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
	last_event_at: T(rev),
	ended_at: null,
	rev,
});

describe("N05 mergeSessions by rev", () => {
	test("an older snapshot never overwrites a newer live update (either arrival order)", () => {
		const live = session("active", 3);
		const snap = session("idle", 1);
		expect(mergeSessions([live], [snap])).toEqual([live]);
		expect(mergeSessions(mergeSessions([], [snap]), [live])).toEqual([live]);
	});

	test("a higher rev wins even when its last_event_at is not newer (stale sweep, remap)", () => {
		const cur = { ...session("active", 4), last_event_at: T(9) };
		const swept = { ...session("stale", 5), last_event_at: T(9) };
		expect(mergeSessions([cur], [swept])).toEqual([swept]);
	});

	test("equal rev → keep what we have (both orders of a tie race)", () => {
		const a = session("active", 7);
		const b = { ...session("idle", 7), cwd: "/other" };
		expect(mergeSessions([a], [b])).toEqual([a]);
		expect(mergeSessions([b], [a])).toEqual([b]);
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

describe("N07 invalidate → refetch → canonical repo id, live 1", () => {
	test("web state after a remap", () => {
		const live = {
			...session("active", 1),
			repo_id: "OCTO-EXAMPLE/ALPHA",
		};
		let state = mergeSessions([], [live]);
		expect(liveCountByRepo(state).get("octo-example/alpha")).toBeUndefined();

		const msg = parseHubMessage(
			JSON.stringify({ kind: "invalidate", scope: ["sessions", "events"] }),
		);
		expect(msg).toEqual({ kind: "invalidate", scope: ["sessions", "events"] });

		// the hub bumped rev when it re-pointed the row, so the refetched snapshot wins
		const refetched = { ...live, repo_id: "octo-example/alpha", rev: 2 };
		state = mergeSessions(state, [refetched]);
		expect(state.map((s) => s.repo_id)).toEqual(["octo-example/alpha"]);
		expect([...liveCountByRepo(state)]).toEqual([["octo-example/alpha", 1]]);
	});

	test("malformed frames are ignored; unknown scopes dropped", () => {
		expect(parseHubMessage("{nope")).toBeNull();
		expect(parseHubMessage(JSON.stringify({ kind: "other" }))).toBeNull();
		expect(
			parseHubMessage(
				JSON.stringify({ kind: "invalidate", scope: ["events", "x"] }),
			),
		).toEqual({ kind: "invalidate", scope: ["events"] });
	});
});
