import { describe, expect, test } from "bun:test";
import {
	codexCommand,
	relPath,
	runningSubagents,
	scrubPaths,
	sessionTails,
	shortModel,
	type TailEvent,
	tailLine,
	tailLines,
} from "./tail.ts";

// made-up folders only (no real user or repo)
const CWD = "/Users/demo/work/orchard";
const WIN = "C:\\Users\\demo\\work\\orchard";
let n = 0;
const ev = (over: Partial<TailEvent>): TailEvent => ({
	session_id: "claude:s1",
	agent_id: "claude:s1",
	type: "PreToolUse",
	tool: "Bash",
	summary: "Bash: ls",
	ts: new Date(Date.UTC(2026, 10, 12, 10, 0, n++)).toISOString(),
	...over,
});
const line = (over: Partial<TailEvent>, cwd: string | null = CWD) =>
	tailLine(ev(over), cwd);

describe("tail lines (15 §3.1 table)", () => {
	test("a command: `$ <first line>`, spaces collapsed", () => {
		expect(line({ summary: "Bash: git   status\nmore lines here" })).toBe(
			"$ git status",
		);
		expect(line({ summary: "Bash: printf 'a\\nb'" })).toBe("$ printf 'a\\nb'");
	});
	test("a file: `<tool> <path>` relative to the session's folder", () => {
		expect(
			line({ tool: "Edit", summary: `Edit ${CWD}/apps/web/src/a.ts` }),
		).toBe("Edit apps/web/src/a.ts");
		expect(line({ tool: "Read", summary: `Read ${CWD}` })).toBe("Read .");
		expect(
			line({ tool: "Edit", summary: `Edit ${WIN}\\apps\\b.ts` }, WIN),
		).toBe("Edit apps\\b.ts");
	});
	test("a file outside the folder: only its last two parts", () => {
		expect(
			line({
				tool: "Read",
				summary: "Read /Users/demo/Documents/shots/screen.png",
			}),
		).toBe("Read shots/screen.png");
		expect(
			line({ tool: "Write", summary: "Write C:\\Users\\demo\\notes\\todo.md" }),
		).toBe("Write notes/todo.md");
		expect(
			line({ tool: "Read", summary: "Read /Users/demo/work/orchard-two/x.ts" }),
		).toBe("Read orchard-two/x.ts");
	});
	test("a subagent: `→ <kind>: <what>`", () => {
		expect(
			line({
				tool: "Agent",
				agent_id: "claude:s1/sub:toolu_1",
				summary: "Agent → reviewer: Review the diff",
			}),
		).toBe("→ reviewer: Review the diff");
		expect(line({ tool: "Task", summary: "Task → Explore: find it" })).toBe(
			"→ Explore: find it",
		);
	});
	test("anything else: the tool name", () => {
		expect(line({ tool: "WebSearch", summary: "WebSearch" })).toBe("WebSearch");
	});
	test("prompt, notification, stop", () => {
		expect(
			line({
				type: "UserPromptSubmit",
				tool: null,
				summary: "prompt (123 chars)",
			}),
		).toBe("› 입력 (123자)");
		expect(
			line({
				type: "Notification",
				tool: null,
				summary: "Claude needs your permission",
			}),
		).toBe("! Claude needs your permission");
		expect(line({ type: "Stop", tool: null, summary: "stop" })).toBe("■ 턴 끝");
		expect(line({ type: "Stop", tool: null, summary: "turn complete" })).toBe(
			"■ 턴 끝",
		);
	});
	test("no line: PostToolUse, SessionStart/End, SubagentStop, codex.*", () => {
		for (const type of [
			"PostToolUse",
			"SessionStart",
			"SessionEnd",
			"SubagentStop",
			"codex.turn_context",
		])
			expect(line({ type, summary: "Bash: ls" })).toBeNull();
	});
	test("Codex: the cmd inside its script; output reads make no line", () => {
		expect(
			line({
				tool: "exec",
				summary:
					"exec: text(await tools.exec_command({cmd:\"python3 - <<'PY'\\nimport x\",yield_time_ms:1000}))",
			}),
		).toBe("$ python3 - <<'PY'");
		expect(
			line({
				tool: "exec",
				summary: 'exec: text(await tools.write_stdin({session_id:8,chars:""}))',
			}),
		).toBeNull();
		expect(
			line({
				tool: "exec",
				summary:
					"exec: for (const n of a) { await tools.view_image({path:`/x`}) }",
			}),
		).toBe("exec");
		expect(codexCommand(`tools.exec_command( { "cmd" : 'ls -la' })`)).toBe(
			"ls -la",
		);
	});
	test("no absolute path survives, in commands too", () => {
		const out = [
			line({ summary: `Bash: cd ${CWD} && cat /Users/demo/.ssh/known_hosts` }),
			line({
				summary: "Bash: S=/private/tmp/claude-501/-Users-demo-x/scratch; ls $S",
			}),
			line({ summary: "Bash: type C:\\Users\\demo\\secret.txt" }, null),
			line({ summary: "Bash: ls ~/Developer/other" }),
		];
		for (const t of out) {
			expect(t).not.toContain("/Users/");
			expect(t).not.toContain("C:\\");
			expect(t).not.toContain("/private/");
		}
		expect(out[0]).toBe("$ cd . && cat …/.ssh/known_hosts");
		// a URL is left as it is
		expect(
			line({ summary: "Bash: curl http://127.0.0.1:4317/api/events" }),
		).toBe("$ curl http://127.0.0.1:4317/api/events");
	});
	test("tricky paths (review): spaces, after an option or `:`, file://, Windows, dashed home folders", () => {
		const cases = [
			'Bash: cat "/Users/John Smith/Desktop/secret.txt"',
			"Bash: type C:\\Users\\John Smith\\Desktop\\secret.txt",
			"Bash: ls /Volumes/My Drive/clients/acme/x",
			"Bash: tool --out:/Users/x/foo/bar",
			"Bash: gcc -I/Users/me/lib/include a.c",
			"Bash: tar -C/Users/me/a/b -xf t.tar",
			"Bash: scp a user@host:/Users/me/a/b/c",
			"Bash: open file:///Users/me/a/b/c",
			"Bash: open file:C:/Users/bob/x",
			"Bash: ls /home/alice/src && cat \\\\server\\share\\x",
			"Bash: cp /Users/me/a.txt /Users/me/b.txt",
			"Bash: S=/private/tmp/claude-501/-Users-demo-x/scratch; ls $S",
		];
		for (const summary of cases) {
			const t = line({ summary }, "/Users/me/proj") ?? "";
			for (const bad of [
				"/Users/",
				"/home/",
				"/Volumes/",
				"/private/",
				"C:\\",
				"C:/",
				"\\\\server",
				"John Smith",
				"-Users-demo",
			])
				expect({ summary, t, has: t.includes(bad) ? bad : null }).toEqual({
					summary,
					t,
					has: null,
				});
		}
		expect(
			line({ summary: 'Bash: cat "/Users/John Smith/Desktop/secret.txt"' }),
		).toBe('$ cat "…/Desktop/secret.txt"');
		expect(
			line(
				{ summary: "Bash: tar -C/Users/me/proj -xf t.tar" },
				"/Users/me/proj",
			),
		).toBe("$ tar -C. -xf t.tar");
	});
	test("equal times keep the hub's order (newest first in, oldest first out)", () => {
		const ts = "2026-11-12T10:00:00.000Z";
		expect(
			tailLines(
				[
					ev({ ts, summary: "Bash: second" }),
					ev({ ts, summary: "Bash: first" }),
				],
				CWD,
			).map((l) => l.text),
		).toEqual(["$ first", "$ second"]);
	});
	test("redacted again before it is drawn (a token-shaped value never shows)", () => {
		const fake = ["ghp", "_", "a".repeat(36)].join("");
		const t = line({ summary: `Bash: echo ${fake}` });
		expect(t).not.toContain(fake);
	});
	test("relPath and scrubPaths keep relative text as it is", () => {
		expect(relPath("src/a.ts", CWD)).toBe("src/a.ts");
		expect(scrubPaths("sed -n 1,5p apps/web/x.ts", CWD)).toBe(
			"sed -n 1,5p apps/web/x.ts",
		);
	});
});

describe("tailLines: oldest first, merged runs, the last N", () => {
	test("the same line in a row becomes one with ×N; the newest is last", () => {
		const list = [
			ev({ summary: "Bash: bun test" }),
			ev({ summary: "Bash: bun test" }),
			ev({ type: "PostToolUse", summary: "Bash: bun test" }),
			ev({ summary: "Bash: bun test" }),
			ev({ tool: "Edit", summary: `Edit ${CWD}/a.ts` }),
			ev({ type: "Stop", tool: null, summary: "stop" }),
		];
		expect(tailLines(list.slice().reverse(), CWD, 3)).toEqual([
			{ text: "$ bun test", count: 3 },
			{ text: "Edit a.ts", count: 1 },
			{ text: "■ 턴 끝", count: 1 },
		]);
		expect(tailLines(list, CWD, 2).map((l) => l.text)).toEqual([
			"Edit a.ts",
			"■ 턴 끝",
		]);
	});
	test("no events: no tail", () => {
		expect(tailLines([], CWD)).toEqual([]);
	});
	test("sessionTails splits by session in one pass", () => {
		const m = sessionTails(
			[
				ev({ summary: "Bash: a" }),
				ev({ session_id: "codex:s2", summary: "Bash: b" }),
			],
			() => null,
		);
		expect(m.get("claude:s1")?.lines).toEqual([{ text: "$ a", count: 1 }]);
		expect(m.get("codex:s2")?.lines).toEqual([{ text: "$ b", count: 1 }]);
	});
});

describe("running subagents", () => {
	test("started and not finished in the window; the main agent never counts", () => {
		const sub = (id: string, type: string) =>
			ev({
				tool: "Agent",
				agent_id: `claude:s1/sub:${id}`,
				type,
				summary: "Agent → x: y",
			});
		expect(
			runningSubagents([
				sub("t1", "PreToolUse"),
				sub("t2", "PreToolUse"),
				sub("t2", "PostToolUse"),
				sub("t3", "PreToolUse"),
				ev({ summary: "Bash: ls" }),
				ev({ type: "PostToolUse", summary: "Bash: ls" }),
			]),
		).toBe(2);
		expect(runningSubagents([ev({}), ev({ type: "PostToolUse" })])).toBe(0);
	});
});

describe("model short names", () => {
	test("claude- prefix and date tail go; version dashes become a dot", () => {
		expect(shortModel("claude-opus-5-5")).toBe("opus 5.5");
		expect(shortModel("claude-fable-5-2")).toBe("fable 5.2");
		expect(shortModel("claude-sonnet-4-20250514")).toBe("sonnet 4");
		expect(shortModel("claude-haiku-5-5-20261001")).toBe("haiku 5.5");
	});
	test("anything else: its first 14 characters; none → null", () => {
		expect(shortModel("gpt-6-astra")).toBe("gpt-6-astra");
		expect(shortModel("some-very-long-model-name-x")).toBe("some-very-long");
		expect(shortModel(null)).toBeNull();
		expect(shortModel("")).toBeNull();
	});
});
