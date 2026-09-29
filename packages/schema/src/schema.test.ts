import { describe, expect, test } from "bun:test";
import { IngestBody, IngestEvent, Machine, Repo, Session } from "./index.ts";

const TS = "2026-01-01T00:00:00.000Z";

describe("row schemas", () => {
	test("Machine parses", () => {
		const m = Machine.parse({
			id: "cockpit",
			hostname: "example-host",
			role: "cockpit",
			last_seen_at: null,
		});
		expect(m.role).toBe("cockpit");
	});

	test("Repo requires owner/name id and a known ci_status", () => {
		const base = {
			id: "example-owner/example-repo",
			is_private: false,
			is_archived: false,
			is_fork: false,
			language: "TypeScript",
			pushed_at: TS,
			commits_30d: 3,
			open_prs: 0,
			open_issues: 1,
			ci_status: "success",
			ci_updated_at: TS,
			district: "uncategorized",
			is_local_only: false,
			synced_at: TS,
		};
		expect(Repo.parse(base).id).toBe("example-owner/example-repo");
		expect(Repo.safeParse({ ...base, id: "no-slash" }).success).toBe(false);
		expect(Repo.safeParse({ ...base, ci_status: "pending" }).success).toBe(
			false,
		);
	});

	test("Session rejects unknown status / provider and non-ISO timestamps", () => {
		const base = {
			id: "s1",
			provider: "claude",
			machine_id: "cockpit",
			repo_id: null,
			cwd: null,
			branch: null,
			model: null,
			status: "active",
			started_at: TS,
			last_event_at: TS,
			ended_at: null,
		};
		expect(Session.safeParse(base).success).toBe(true);
		expect(Session.safeParse({ ...base, status: "busy" }).success).toBe(false);
		expect(Session.safeParse({ ...base, provider: "gpt" }).success).toBe(false);
		expect(
			Session.safeParse({ ...base, started_at: "yesterday" }).success,
		).toBe(false);
	});
});

describe("IngestEvent", () => {
	const minimal = {
		id: "e1",
		ts: TS,
		machine_id: "cockpit",
		session_id: "s1",
		provider: "claude",
		type: "PreToolUse",
	};

	test("fills nullable defaults", () => {
		const e = IngestEvent.parse(minimal);
		expect(e).toMatchObject({
			agent_id: null,
			tool: null,
			summary: null,
			repo_id: null,
			payload_redacted: {},
		});
	});

	test("accepts unknown event types (codex records)", () => {
		expect(
			IngestEvent.safeParse({ ...minimal, type: "codex.unknown_thing" })
				.success,
		).toBe(true);
	});

	test("requires session_id", () => {
		const { session_id: _, ...rest } = minimal;
		expect(IngestEvent.safeParse(rest).success).toBe(false);
	});

	test("IngestBody accepts one event or a non-empty batch", () => {
		expect(IngestBody.safeParse(minimal).success).toBe(true);
		expect(
			IngestBody.safeParse([minimal, { ...minimal, id: "e2" }]).success,
		).toBe(true);
		expect(IngestBody.safeParse([]).success).toBe(false);
	});
});
