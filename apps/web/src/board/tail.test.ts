import { describe, expect, test } from "bun:test";
import { summarizeToolInput } from "@agent-city/schema";
import {
	codexCommand,
	commandLine,
	eventLine,
	hideCredentials,
	relPath,
	runningSubagents,
	scrubPaths,
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
		).toBe("$ python3 (스크립트)");
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
		expect(out[0]).toBe("$ cat …/.ssh/known_hosts");
		expect(
			line({ summary: "Bash: cat /Users/demo/notes/today.md && bun run lint" }),
		).toBe("$ cat …/notes/today.md && bun run lint");
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
});

describe("what a command shows (REVIEW 2026-11-13 #1)", () => {
	const cmd = (summary: string) => line({ summary: `Bash: ${summary}` });
	test("leading assignments and `cd … &&` / `cd …;` go; the real command shows", () => {
		expect(cmd("cd /Users/demo/work/x && bun test apps/web")).toBe(
			"$ bun test apps/web",
		);
		expect(cmd("cd ~/Downloads; ls -la shots")).toBe("$ ls -la shots");
		expect(cmd("P=~/Downloads/a/b.html; grep -n steps $P")).toBe(
			"$ grep -n steps $P",
		);
		expect(cmd("S=/private/tmp/claude-501/-Users-demo-x/scratch\nls $S")).toBe(
			"$ ls $S",
		);
		expect(commandLine('A=1 B="two words" bun run dev')).toBe("bun run dev");
		expect(commandLine("export DEBUG=1 && cd apps/web && vite build")).toBe(
			"vite build",
		);
		expect(commandLine("X=$(mktemp -d) && cd $X && git init")).toBe("git init");
		expect(commandLine("# a note\n\ncd a\nmake")).toBe("make");
		expect(commandLine("cd a &&\\\n  make all")).toBe("make all");
		// a group's opener and closer both go
		expect(commandLine("(nohup bunx vite preview > log 2>&1 &)")).toBe(
			"nohup bunx vite preview > log 2>&1 &",
		);
		expect(commandLine("(cd /tmp && ls)")).toBe("ls");
		expect(commandLine("{ echo hi; }")).toBe("echo hi");
	});
	test("a heredoc or inline script: the program and (스크립트)", () => {
		expect(cmd("python3 - <<'EOF'\nimport os\nprint(1)")).toBe(
			"$ python3 (스크립트)",
		);
		// a heredoc fed to an ordinary program: the command up to it
		expect(commandLine("cat >> notes/PROGRESS.md <<'EOF'\n## x")).toBe(
			"cat >> notes/PROGRESS.md (스크립트)",
		);
		expect(commandLine("git commit -m \"$(cat <<'EOF'\nmsg")).toBe(
			"git commit -m (스크립트)",
		);
		expect(commandLine("mkdir -p out && cat > out/a.md <<'EOF'")).toBe(
			"mkdir -p out && cat > out/a.md (스크립트)",
		);
		expect(commandLine("bun -e '\nconst j = 1;\n'")).toBe("bun (스크립트)");
		expect(commandLine('node -e "console.log(1)"')).toBe("node (스크립트)");
		expect(commandLine("/usr/bin/python3 -u -c 'print(1)'")).toBe(
			"python3 (스크립트)",
		);
		expect(commandLine("php -r 'echo 1;'")).toBe("php (스크립트)");
		expect(commandLine("pwsh -Command Get-Date")).toBe("pwsh (스크립트)");
		expect(commandLine("bash -lc 'make && make test'")).toBe("bash (스크립트)");
		expect(commandLine("cd x && osascript -e 'tell app'")).toBe(
			"osascript (스크립트)",
		);
		expect(commandLine("S=/tmp/x; bun -e 'x'")).toBe("bun (스크립트)");
	});
	test("`-e` / `-c` elsewhere is an ordinary flag", () => {
		for (const c of [
			"grep -c TODO src/a.ts",
			"wc -c a.txt",
			"head -c 100 a.bin",
			"git -c core.pager=cat log",
			"sed -e s/a/b/ f",
			"python3 tool.py -c conf.yaml",
			"bun run check -e",
			"bash -e deploy.sh",
			"sh -ex run.sh",
			'grep x <<< "$y"',
			"git log --format='<<%h>>'",
			'echo "a << b" && cat x',
			"node -r dotenv/config app.js",
			"pwsh -ExecutionPolicy Bypass -File x.ps1",
		])
			expect(commandLine(c)).toBe(c);
	});
	test("cut by the hook at 80 characters with only a prefix left: the prefix stands for it", () => {
		const long =
			`S=/private/tmp/claude-501/-Users-demo-x/${"f".repeat(60)}`.slice(0, 80);
		expect(cmd(long)).toBe("$ S=…");
		expect(
			cmd("cd /Users/demo/work/x && AGENTCITY_AB_OUT=$HOME/Documents/a"),
		).toBe("$ AGENTCITY_AB_OUT=…");
		// the cut fell inside the next variable's name
		expect(commandLine("cd x && A_OUT=$HOME/a AGENTCITY_BOARD_U")).toBe(
			"A_OUT=…",
		);
		expect(commandLine("X=1 make")).toBe("make");
		expect(commandLine("X=1 MAKE_ALL\nls")).toBe("MAKE_ALL");
		expect(cmd("cd /Users/demo/work/x/apps/web")).toBe("$ cd …/apps/web");
		expect(cmd("cd x | tee a")).toBe("$ cd x | tee a");
	});
	test("Codex: the whole cmd is read (escaped new lines), then the same rule", () => {
		expect(
			line({
				tool: "exec",
				summary:
					'exec: text(await tools.exec_command({cmd:"cd /Users/demo/work/x && rg -n TODO src"}))',
			}),
		).toBe("$ rg -n TODO src");
		expect(
			codexCommand('exec_command({cmd:"A=1\\ncd b\\nbun -e \\"x\\""})'),
		).toBe('A=1\ncd b\nbun -e "x"');
	});
	test("no absolute path or user name in any of the new shapes", () => {
		for (const c of [
			"S=/Users/demo/secret/a.txt",
			"cd /Users/demo/work/x",
			"cd /home/demo/a && cat /home/demo/b/c.txt",
			"python3 /Users/demo/bin/x.py -c 1",
			"/Users/demo/bin/python3 -c 'x'",
			"cd C:\\Users\\demo\\a && type C:\\Users\\demo\\b\\c.txt",
			// a quoted interpreter path with a space never leaves a piece of it as the program (review P1)
			"\"/Users/demo person/.venv/bin/python\" - <<'EOF'",
			'"/Users/demo person/tool" - <<EOF',
			'cd "/Users/demo person/p" && "/Users/demo person/x/python" -c 1',
			'"C:\\Users\\demo person\\python.exe" - <<EOF',
			// a space escaped with a backslash is part of the folder name (review follow-up)
			"S=/Users/demo\\ person/x; ls",
			"cat /Users/demo\\ person/secret.txt",
			"cd /Users/demo\\ person/p && make",
			"/Users/demo\\ person/bin/python3 - <<EOF",
		]) {
			const t = line({ summary: `Bash: ${c}` }, null) ?? "";
			expect(t).not.toMatch(/\/Users\/|\/home\/|C:\\|demo|person/);
		}
	});
	test("bounded: a huge command is looked at only up to SCRIPT_MAX", () => {
		const t0 = performance.now();
		const huge = `${"A=1 ".repeat(50_000)}${"x".repeat(100_000)}`;
		expect(commandLine(huge)).toBe("A=…");
		expect(commandLine(`cd ${"a ".repeat(50_000)}`)).toContain("cd");
		expect(performance.now() - t0).toBeLessThan(200);
	});
});

describe("credentials the shared redaction misses (INBOX-A B2 P1)", () => {
	// a made-up value built at runtime: never a real secret in the repo
	const fake = ["synthetic", "Canary42"].join("");
	const bash = (command: string) =>
		line({
			summary: `Bash: ${summarizeToolInput("Bash", { command }).command}`,
		});
	const cases: [string, string][] = [
		[`curl --password "${fake}`, "$ curl --password [REDACTED]"],
		[`curl --password '${fake}`, "$ curl --password [REDACTED]"],
		[
			`curl -H "Authorization: Custom ${fake}" example.test`,
			'$ curl -H "Authorization: [REDACTED]',
		],
		[`Invoke-X -Password '${fake}'`, "$ Invoke-X -Password [REDACTED]"],
		[`echo password="${fake}`, "$ echo password=[REDACTED]"],
		[`mysql --passphrase ${fake} db`, "$ mysql --passphrase [REDACTED]"],
		[`export SECRET_KEY:${fake}`, "$ export SECRET_KEY:[REDACTED]"],
		[`curl --cookie "sid=${fake}" x`, "$ curl --cookie [REDACTED]"],
	];
	for (const [input, shown] of cases)
		test(`${input.replace(fake, "<fake>")} → ${shown}`, () => {
			const out = bash(input);
			expect(out).toBe(shown);
			expect(out ?? "").not.toContain(fake);
		});

	test("a word with no value after it, or inside a longer name, is left alone", () => {
		for (const s of [
			"$ cat secret.txt",
			"Edit src/token-store.ts",
			"$ ls tokens/",
			"$ pwd",
			"$ curl --password",
			'$ curl --password "[REDACTED]"',
			"$ echo TOKEN=[REDACTED]",
		])
			expect(hideCredentials(s)).toBe(s);
	});

	test("linear in the line's length", () => {
		const long = `${"token".repeat(20_000)}x`;
		const t = performance.now();
		hideCredentials(long);
		hideCredentials(`${"a ".repeat(100_000)}password`);
		expect(performance.now() - t).toBeLessThan(200);
	});
});

describe("the detail screen's event lines (16 A3): every event, cleaned like the tails", () => {
	test("a tool's PreToolUse is its tail line; its PostToolUse reads the same", () => {
		const pre = ev({ summary: "Bash: cat /Users/demo/work/orchard/src/a.ts" });
		expect(eventLine(pre, CWD)).toBe("$ cat ./src/a.ts");
		expect(eventLine({ ...pre, type: "PostToolUse" }, CWD)).toBe(
			"$ cat ./src/a.ts",
		);
	});

	test("other events: type and summary, absolute paths gone, credentials hidden", () => {
		const fake = ["synthetic", "Canary42"].join("");
		for (const [summary, type] of [
			["started in /Users/demo/private/notes", "SessionStart"],
			[`token=${fake}`, "Notification"],
			["C:\\Users\\demo\\x", "SessionEnd"],
		] as const) {
			const out = eventLine(ev({ type, tool: null, summary }), null);
			expect(out).not.toContain("/Users/");
			expect(out).not.toContain("\\Users\\");
			expect(out).not.toContain(fake);
		}
		expect(
			eventLine(ev({ type: "SessionStart", tool: null, summary: null }), null),
		).toBe("SessionStart");
	});

	test("a tool line the tails drop (Codex typing into a running command) shows its tool name only", () => {
		const fake = ["hunter", "2"].join("");
		const typed = ev({
			tool: "exec",
			summary: `exec: text(await tools.write_stdin({session_id:3,chars:"${fake}\\n"}))`,
		});
		expect(tailLine(typed, null)).toBeNull();
		expect(eventLine(typed, null)).toBe("exec");
		expect(eventLine({ ...typed, type: "PostToolUse" }, null)).toBe("exec");
	});

	test("another user's ~name never shows (tails and the detail screen)", () => {
		const out = eventLine(
			ev({
				type: "Notification",
				tool: null,
				summary: "see ~alice/notes and ~bob",
			}),
			null,
		);
		expect(out).not.toContain("alice");
		expect(out).not.toContain("bob");
		expect(line({ summary: "Bash: ~carol/bin/run --fast" })).not.toContain(
			"carol",
		);
		// a git revision is not a home folder
		expect(line({ summary: "Bash: git show HEAD~2" })).toBe(
			"$ git show HEAD~2",
		);
	});

	test("a long line is cut at LINE_MAX", () => {
		const out = eventLine(
			ev({ type: "SessionStart", tool: null, summary: "x".repeat(500) }),
			null,
		);
		expect(out.length).toBeLessThanOrEqual(160);
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
