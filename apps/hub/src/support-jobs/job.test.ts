// Support job domain: creation, rejection of bad input, and absence of any mutation authority.
import { describe, expect, test } from "bun:test";
import {
	createSupportJob,
	parseSupportJob,
	SUPPORT_JOB_KINDS,
	SupportInputRef,
	type SupportJob,
	SupportJobRequest,
} from "./job.ts";
import { DEFAULT_REFS, queued, T0 } from "./testkit.ts";

const meta = { id: "sj-1", created_seq: 1, created_at: T0 };
const base = {
	repo_id: "acme/widgets",
	kind: "REPO_STATUS",
	capability: "FAST",
} as const;

describe("1. valid support job creation", () => {
	test("minimal request → frozen QUEUED job with defaults", () => {
		const r = createSupportJob(base, meta);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.job).toEqual({
			id: "sj-1",
			repo_id: "acme/widgets",
			kind: "REPO_STATUS",
			capability: "FAST",
			inputs: [],
			brief: null,
			status: "QUEUED",
			priority: 50,
			created_seq: 1,
			created_at: T0,
			disabled: false,
			cancel_requested: false,
			profile_id: null,
			result: null,
			failure: null,
		});
		expect(Object.isFrozen(r.job)).toBe(true);
		expect(Object.isFrozen(r.job.inputs)).toBe(true);
	});

	test.each([...SUPPORT_JOB_KINDS])("%s with its required refs", (kind) => {
		const r = createSupportJob(
			{ ...base, kind, capability: "STANDARD", inputs: DEFAULT_REFS[kind] },
			meta,
		);
		expect(r.ok).toBe(true);
	});

	test("repo id is normalized; local/<dir> keeps its folder name verbatim", () => {
		const a = createSupportJob({ ...base, repo_id: "  Acme/Widgets/ " }, meta);
		expect(a.ok && a.job.repo_id).toBe("Acme/Widgets");
		const b = createSupportJob({ ...base, repo_id: "local/my repo.git" }, meta);
		expect(b.ok && b.job.repo_id).toBe("local/my repo.git");
	});

	test("brief and explicit priority are kept", () => {
		const r = createSupportJob(
			{ ...base, brief: "focus on the flaky test", priority: 90 },
			meta,
		);
		expect(r.ok && r.job.brief).toBe("focus on the flaky test");
		expect(r.ok && r.job.priority).toBe(90);
	});
});

describe("2. invalid kind / input rejection", () => {
	const bad: [string, unknown][] = [
		["unknown kind", { ...base, kind: "IMPLEMENT" }],
		["lower-case kind", { ...base, kind: "repo_status" }],
		["unknown capability", { ...base, capability: "HAIKU" }],
		["repo id without owner", { ...base, repo_id: "widgets" }],
		["repo id path traversal", { ...base, repo_id: "acme/.." }],
		["repo id absolute path", { ...base, repo_id: "/Users/someone/code" }],
		["repo id nested path", { ...base, repo_id: "local/a/b" }],
		["repo id too long", { ...base, repo_id: `local/${"x".repeat(300)}` }],
		["priority above max", { ...base, priority: 101 }],
		["priority negative", { ...base, priority: -1 }],
		["priority fractional", { ...base, priority: 1.5 }],
		["empty brief", { ...base, brief: "" }],
		["brief too long", { ...base, brief: "x".repeat(2001) }],
		[
			"too many refs",
			{
				...base,
				inputs: Array.from({ length: 33 }, (_, i) => ({
					kind: "run",
					id: `r${i}`,
				})),
			},
		],
		[
			"duplicate refs",
			{
				...base,
				inputs: [
					{ kind: "run", id: "r1" },
					{ kind: "run", id: "r1" },
				],
			},
		],
		["ref with unknown kind", { ...base, inputs: [{ kind: "file", id: "a" }] }],
		[
			"ref id is a path",
			{ ...base, inputs: [{ kind: "log", id: "/var/log/x" }] },
		],
		["ref id with '..'", { ...base, inputs: [{ kind: "log", id: "a..b" }] }],
		[
			"commit ref not hex",
			{ ...base, inputs: [{ kind: "commit", id: "HEAD" }] },
		],
		["LOG_TRIAGE without log/run ref", { ...base, kind: "LOG_TRIAGE" }],
		[
			"REVIEW_TO_TODOS without review ref",
			{ ...base, kind: "REVIEW_TO_TODOS" },
		],
		["PR_DRAFT without commit ref", { ...base, kind: "PR_DRAFT" }],
		[
			"EVIDENCE_SUMMARY without artifact/run ref",
			{ ...base, kind: "EVIDENCE_SUMMARY" },
		],
		["status is not requestable", { ...base, status: "COMPLETED" }],
		["profile is not requestable", { ...base, profile_id: "fast-1" }],
		["not an object", "REPO_STATUS"],
		["null", null],
	];
	test.each(bad)("%s", (_name, request) => {
		const r = createSupportJob(request, meta);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
	});

	test("brief containing a credential is rejected without echoing it", () => {
		const fake = `gh${"p_"}${"A".repeat(36)}`;
		const r = createSupportJob({ ...base, brief: `use ${fake}` }, meta);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.issues.join(" ")).not.toContain(fake);
	});

	test("invalid meta (id, seq, timestamp) is rejected", () => {
		expect(createSupportJob(base, { ...meta, id: "../x" }).ok).toBe(false);
		expect(createSupportJob(base, { ...meta, created_seq: -1 }).ok).toBe(false);
		expect(
			createSupportJob(base, { ...meta, created_at: "2026-10-06 00:00" }).ok,
		).toBe(false);
	});
});

describe("3. read-only contract: no mutation authority", () => {
	const authorityKeys = [
		"command",
		"argv",
		"shell",
		"write_path",
		"cwd",
		"push",
		"git_push",
		"merge",
		"deploy",
		"token",
		"api_key",
		"credential",
		"password",
		"env",
	];

	test.each(authorityKeys)("request with '%s' is rejected", (key) => {
		const sentinel = "SENTINEL-VALUE-7f3a";
		const r = createSupportJob({ ...base, [key]: sentinel }, meta);
		expect(r.ok).toBe(false);
		// Issues name the location and code, never the offending value.
		if (!r.ok) expect(r.issues.join(" ")).not.toContain(sentinel);
	});

	test.each(authorityKeys)("input ref with '%s' is rejected", (key) => {
		expect(
			SupportInputRef.safeParse({ kind: "run", id: "r1", [key]: "x" }).success,
		).toBe(false);
	});

	test("the request schema declares no authority fields", () => {
		const shape = Object.keys(SupportJobRequest.shape);
		expect(shape.sort()).toEqual(
			[
				"brief",
				"capability",
				"disabled",
				"inputs",
				"kind",
				"priority",
				"repo_id",
			].sort(),
		);
	});

	test("the SupportJob type has no authority fields (compile-time)", () => {
		type Forbidden =
			| "command"
			| "argv"
			| "shell"
			| "write_path"
			| "cwd"
			| "path"
			| "push"
			| "deploy"
			| "token"
			| "credential"
			| "url"
			| "env";
		const _noAuthority: Extract<keyof SupportJob, Forbidden> extends never
			? true
			: false = true;
		expect(_noAuthority).toBe(true);
	});

	test("a job object with an extra authority key fails re-validation", () => {
		const job = queued({ id: "sj-x" });
		expect(parseSupportJob(job)).not.toBeNull();
		for (const key of authorityKeys)
			expect(parseSupportJob({ ...job, [key]: "x" })).toBeNull();
	});
});
