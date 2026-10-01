// Runs under `bun test`; excluded from the web tsconfig (DOM/vite types, no bun types).
import { describe, expect, test } from "bun:test";
import type { Event, Session } from "@agent-city/schema";
import {
	liveCountByRepo,
	mergeDistricts,
	mergeEventSnapshot,
	mergeEvents,
	mergeSessions,
	parseHubMessage,
	upsertRepo,
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

// ── v0.1.1 Phase 5 A: Observed-sessions response races ──────────────────────

describe("late responses cannot roll the observed view back", () => {
	const evt = (id: string, repo: string, provider = "claude") =>
		({ id, ts: T(1), repo_id: repo, provider, type: "PreToolUse" }) as Event;

	test("a late events snapshot for an OLD filter cannot inject non-matching rows", () => {
		const current = [evt("b1", "o/b")];
		const lateForRepoA = [evt("a1", "o/a"), evt("a2", "o/a")];
		const now = { repo: "o/b", provider: null };
		expect(
			mergeEventSnapshot(current, lateForRepoA, now).map((e) => e.id),
		).toEqual(["b1"]);
		// the latest selection's own snapshot is merged normally
		expect(
			mergeEventSnapshot([], [evt("b2", "o/b"), evt("a3", "o/a")], now).map(
				(e) => e.id,
			),
		).toEqual(["b2"]);
		// provider filter too
		expect(
			mergeEventSnapshot([], [evt("c1", "o/b", "codex")], {
				repo: null,
				provider: "claude",
			}),
		).toEqual([]);
	});

	const repo = (
		id: string,
		district: string,
		synced: string | null,
		ci: string | null = null,
	) =>
		({ id, district, synced_at: synced, ci_updated_at: ci }) as never as {
			id: string;
			district: string;
			synced_at: string | null;
			ci_updated_at: string | null;
		};

	test("a late REST repo snapshot cannot overwrite a newer live repo frame", () => {
		const live = upsertRepo({}, repo("o/a", "games", T(5)));
		const lateSnapshot = {
			school: [repo("o/a", "school", T(1))],
			games: [repo("o/b", "games", T(1))],
		};
		const merged = mergeDistricts(live, lateSnapshot);
		expect(merged.games?.map((r) => r.id).sort()).toEqual(["o/a", "o/b"]);
		expect(merged.school).toBeUndefined(); // o/a kept its newer district
		// a NEWER snapshot does win
		const newer = mergeDistricts(live, {
			school: [repo("o/a", "school", T(9))],
		});
		expect(newer.school?.map((r) => r.id)).toEqual(["o/a"]);
		// ci_updated_at breaks a synced_at tie
		const ci = mergeDistricts(
			{ games: [repo("o/c", "games", T(5), T(7))] },
			{ games: [repo("o/c", "games", T(5), T(6))] },
		);
		expect(ci.games?.[0]?.ci_updated_at).toBe(T(7));
	});

	test("an older live repo frame is ignored; an equal or newer one applies", () => {
		const cur = { games: [repo("o/a", "games", T(5))] };
		expect(upsertRepo(cur, repo("o/a", "infra", T(4))).infra).toBeUndefined();
		expect(upsertRepo(cur, repo("o/a", "infra", T(5))).infra?.[0]?.id).toBe(
			"o/a",
		);
		expect(upsertRepo(cur, repo("o/a", "infra", T(6))).games).toBeUndefined();
	});

	test("malformed event / session / repo frames fail safely", () => {
		for (const raw of [
			{ kind: "event", data: { id: "x" } },
			{ kind: "event", data: "nope" },
			{ kind: "session", data: { id: "s", status: "active" } }, // no rev
			{ kind: "session", data: null },
			{ kind: "repo", data: { id: "o/a" } }, // no district
			{ kind: "repo", data: [1, 2] },
			[1, 2, 3],
			null,
		])
			expect(parseHubMessage(JSON.stringify(raw))).toBeNull();
		expect(
			parseHubMessage(
				JSON.stringify({
					kind: "repo",
					data: { id: "o/a", district: "games" },
				}),
			)?.kind,
		).toBe("repo");
		expect(
			parseHubMessage(
				JSON.stringify({
					kind: "session",
					data: { id: "s", status: "active", last_event_at: T(1), rev: 1 },
				}),
			)?.kind,
		).toBe("session");
	});
});
