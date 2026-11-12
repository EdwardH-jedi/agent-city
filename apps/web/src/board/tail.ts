// The terminal tail under a working session (design doc 15 §3.1): its last few tool events, one short
// line each, from the events the screen already has (useHub: /api/events?limit=200, then ws `event`) —
// no request of its own. Pure, no React. Only `type`, `tool`, `summary`, `agent_id`, `session_id` and
// `ts` are read; never `payload_redacted`. The collector has redacted every summary already; each line
// is redacted again here (two locks) and stripped of absolute paths: a path inside the session's folder
// becomes relative to it, any other absolute path keeps its last two parts. Command output and prompt
// text are not in the hub (decision D5), so they are never here either.
//
//   PreToolUse  `<tool>: <command>`      → `$ <command>` (commandLine: leading `NAME=…` / `export` and
//                                          `cd … &&` / `cd …;` dropped, then the first line, spaces collapsed;
//                                          a heredoc or inline script → `$ <program> (스크립트)`)
//   PreToolUse  `<tool> <path>`          → `<tool> <relative path>`
//   PreToolUse  `Agent → <kind>: <what>` → `→ <kind>: <what>` (a subagent starts; `Task` too)
//   PreToolUse  anything else            → `<tool>`
//   UserPromptSubmit                     → `› 입력 (N자)` (only the length is ever stored)
//   Notification                         → `! <text>`
//   Stop                                 → `■ 턴 끝`
//   PostToolUse, SessionStart/End, SubagentStop, codex.* → no line
// Codex wraps its shell calls in a small script (`exec: text(await tools.exec_command({cmd:"…"}))`, seen
// on the hub 2026-11-12): the `cmd` string is the command. A script that only reads a running command's
// output (`write_stdin`) makes no line; any other script shows as its tool name.
// The collector keeps only the first 80 characters of a command (COMMAND_MAX in packages/schema): when the
// dropped prefixes fill all of them (`S=/private/tmp/…` and nothing else), the line is the last prefix with
// its value cut (`$ S=…`) — the command itself never reached the hub.
import type { Event } from "@agent-city/schema";
import { redact, SUBAGENT_TOOLS } from "@agent-city/schema/core";

export type TailEvent = Pick<
	Event,
	"session_id" | "agent_id" | "type" | "tool" | "summary" | "ts"
>;

export interface TailLine {
	text: string;
	/** How many times in a row the same line came (`×3` when more than one). */
	count: number;
}

/** Lines kept per session (the box shows 3, or 2 on a screen under 1600 px). */
export const TAIL_MAX = 3;
/** Characters kept of one line (the box ends it with an ellipsis anyway). */
export const LINE_MAX = 160;
/** Characters of a command looked at (the hook sends 80; a Codex `cmd` can be longer). */
export const SCRIPT_MAX = LINE_MAX * 8;

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
/** The first real line of a command, spaces collapsed. */
const firstLine = (s: string): string =>
	collapse((s.slice(0, LINE_MAX * 4).split(/\r?\n/)[0] ?? "").trim());

const isSep = (c: string | undefined) => c === "/" || c === "\\";
const trimSeps = (p: string): string => {
	let end = p.length;
	while (end > 1 && isSep(p[end - 1])) end--;
	return p.slice(0, end);
};

/** An absolute path: `/…`, `~…`, `C:\…` / `C:/…`, `\\server\…`. */
const isAbsolute = (p: string): boolean =>
	p.startsWith("/") ||
	p.startsWith("~") ||
	p.startsWith("\\\\") ||
	/^[A-Za-z]:[\\/]/.test(p);

/** A file path for the tail: relative to the session's folder when inside it, else its last two parts. */
export function relPath(path: string, cwd: string | null): string {
	const p = path.trim();
	const base = cwd ? trimSeps(cwd.trim()) : "";
	if (base.length > 1) {
		if (p === base) return ".";
		if (p.startsWith(base) && isSep(p[base.length]))
			return p.slice(base.length + 1).trim() || ".";
	}
	if (!isAbsolute(p)) return p;
	return scrubPaths(p, null).replace(/^…\//, "");
}

// Home-like roots: whatever follows them names a person or a private folder. Matched wherever they stand
// (after `-I`, `--out:`, `host:`, `file://` too), and consumed up to the next quote, shell operator or end
// of line, so a folder name with spaces (`/Users/John Smith/…`) goes with it; the root and the folder
// right under it (the user name) are dropped, the last two parts after that kept.
const HOME_ROOT =
	/(?:[A-Za-z]:)?[\\/]+(?:Users|home|Volumes|private|root|mnt|media|var\/folders)(?=[\\/])(?:[^"'`;|&<>()\s]|[ \t](?![\s/\\~-]|[A-Za-z]:[\\/]))*/gi;
// a folder name that spells a home path with dashes (`-Users-<name>-…`, as tools encode them)
const DASHED_HOME = /-(Users|home)-[^-/\\\s"'`]+/g;
// Any other absolute path in free text — `/…`, `~/…`, `X:\…`, `\\server\…` — not inside a relative path
// (`apps/web`) or a web URL (`https://host/a`, skipped below).
const ABS_IN_TEXT =
	/(?:[a-z][a-z0-9+.-]*:\/\/[^\s"'`]*)|(?<![\w.~/\\…])(?:~?\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`;|&<>()=,]*/gi;
const WEB_URL = /^(?:https?|wss?|ftp|ssh|git|svn):\/\//i;

const tailOf = (p: string, skip: number): string => {
	const parts = p
		.split(/[\\/]+/)
		.filter((x) => x && x !== "~" && !/^[A-Za-z]:$/.test(x));
	return parts.slice(skip).slice(-2).join("/").trim();
};

/**
 * No absolute path survives in a line: the session's folder (at a path boundary) becomes `.`, a
 * home-like folder `…/<last two parts below the user>` (or `~`), any other absolute path
 * `…/<last two parts>`. Web URLs (`https://…`) are left alone; `file://` is a path.
 */
export function scrubPaths(text: string, cwd: string | null): string {
	let s = text;
	const base = cwd ? trimSeps(cwd.trim()) : "";
	if (base.length > 1) {
		let out = "";
		let i = 0;
		for (;;) {
			const at = s.indexOf(base, i);
			if (at < 0) break;
			const after = s[at + base.length];
			const before = at > 0 ? s[at - 1] : undefined;
			const boundary =
				(after === undefined || isSep(after) || /[\s"'`;|&)]/.test(after)) &&
				!isSep(before);
			out += s.slice(i, at) + (boundary ? "." : base);
			i = at + base.length;
		}
		s = out + s.slice(i);
	}
	s = s.replace(DASHED_HOME, "-$1-…");
	s = s.replace(HOME_ROOT, (m) => {
		// `\ ` is an escaped space inside a folder name (`/Users/John\ Smith`), not a separator
		const rest = tailOf(m.replace(/\\(?=[ \t])/g, ""), 2);
		const space = /\s*$/.exec(m)?.[0] ?? "";
		return (rest ? `…/${rest}` : "~") + space;
	});
	return s.replace(ABS_IN_TEXT, (m) => {
		if (WEB_URL.test(m)) return m;
		const rest = tailOf(
			m.replace(/^file:\/\//i, "").replace(/\\(?=[ \t])/g, ""),
			0,
		);
		return rest ? `…/${rest}` : "…";
	});
}

/**
 * Codex's script → the shell command in it: the string after `exec_command({cmd:` (key quoted or not,
 * `"`, `'` or `` ` `` quotes, spaces allowed), escapes undone (`\n` is a new line), at most SCRIPT_MAX
 * characters. `write_stdin` only → null
 * (it reads a running command's output). Anything else → "" (the caller shows the tool name).
 */
export function codexCommand(code: string): string | null {
	const m = /exec_command\s*\(\s*\{\s*["']?cmd["']?\s*:\s*(["'`])/.exec(code);
	if (!m) return /\bwrite_stdin\s*\(/.test(code) ? null : "";
	const quote = m[1];
	let out = "";
	for (let i = m.index + m[0].length; i < code.length; i++) {
		const ch = code[i];
		if (ch === "\\") {
			const next = code[i + 1];
			if (next === undefined) break;
			out +=
				next === "n" ? "\n" : next === "r" ? "" : next === "t" ? " " : next;
			i++;
			continue;
		}
		if (ch === quote) break;
		out += ch;
		if (out.length > SCRIPT_MAX) break;
	}
	return out;
}

// ── what a shell command shows (REVIEW 2026-11-13 #1) ────────────────────────────────────────────

// Programs that run a script given inline, and the flag that gives it: `-c` for a shell, Python or
// PowerShell (`bash -lc`, `python3 -c`; a shell's `-e` is errexit), `-e` for the others (`bun -e`, `node
// -e`, `osascript -e`, `php -r`). The same letters after any other program are ordinary flags (`grep -c`,
// `git -c`, `head -c`, `sed -e`).
const C_INTERPRETER =
	/^(?:sh|bash|zsh|dash|ksh|fish|python[0-9.]*|pypy[0-9.]*|pwsh|powershell)$/i;
const E_INTERPRETER =
	/^(?:bun|node|nodejs|deno|tsx|ts-node|ruby|perl|php|lua|osascript)$/i;
const C_FLAG = /^(?:-[a-z]{0,3}c[a-z]{0,2}|--command|-Command)$/;
const E_FLAG = /^(?:-[a-z]{0,3}[ep]|--eval|--print)$/;
/** php's `-r` runs code; for node / bun / ruby it is `--require`. */
const PHP_FLAG = /^-r$/;
/** A program name shown on its own: a plain file name, nothing that could be a piece of a path. */
const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
const ASSIGN = /[A-Za-z_][A-Za-z0-9_]*=/y;
const CD = /cd(?=[ \t;&|\n]|$)/y;

const isBlank = (c: string | undefined) => c === " " || c === "\t";

/** End of the shell word at `i`: quotes and `$( … )` kept whole, up to a blank or an operator. Linear. */
function wordEnd(s: string, i: number): number {
	let depth = 0;
	while (i < s.length) {
		const c = s[i] as string;
		if (c === "\\") {
			i += 2; // an escaped character (`\ ` in a folder name) belongs to the word
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			const close = s.indexOf(c, i + 1);
			i = close < 0 ? s.length : close + 1;
			continue;
		}
		if (c === "$" && s[i + 1] === "(") {
			depth++;
			i += 2;
			continue;
		}
		if (depth > 0) {
			if (c === ")") depth--;
			i++;
			continue;
		}
		if (isBlank(c) || c === "\n" || c === ";" || c === "&" || c === "|") break;
		i++;
	}
	return i;
}

/** After a prefix: past blanks and one `&&`, `;` or new line. -1 when what follows is not one of them. */
function pastSeparator(s: string, i: number): number {
	while (isBlank(s[i])) i++;
	if (s.startsWith("&&", i)) return i + 2;
	if (s[i] === ";" || s[i] === "\n") return i + 1;
	return i >= s.length ? i : -1;
}

/**
 * The part of a shell command worth a tail line: leading variable assignments (`S=…`, `export A=1`, `A=1
 * cmd`), `cd <dir> &&` / `cd <dir>;`, blank and comment lines and a group's `(` … `)` / `{` … `}` go; of
 * what is left the first line, spaces collapsed. An inline script (`-c` after a shell or Python, `-e`
 * after bun / node / …) or a heredoc fed to an interpreter shows as `<program> (스크립트)`; a heredoc fed
 * to another program as the command up to it (`cat > a.md (스크립트)`, `git commit -m (스크립트)`). The
 * program is named only when it is a plain file name (never a piece of a quoted path). When nothing is left (the hook cut the command at 80 characters), the last
 * prefix stands for it: an assignment as `NAME=…`, a `cd` as itself. Every step is a linear scan.
 */
export function commandLine(raw: string): string {
	const s = raw.slice(0, SCRIPT_MAX).replace(/\\\r?\n/g, " ");
	let i = 0;
	let last = "";
	let opened = 0;
	for (;;) {
		// blanks, `;` and a group's opening `(` / `{` between prefixes (their closers go below)
		while (i < s.length && /[\s;({]/.test(s[i] as string)) {
			if (s[i] === "(" || s[i] === "{") opened++;
			i++;
		}
		if (s[i] === "#") {
			const nl = s.indexOf("\n", i);
			i = nl < 0 ? s.length : nl + 1;
			continue;
		}
		let j = i;
		if (s.startsWith("export ", j)) {
			j += 7;
			while (isBlank(s[j])) j++;
		}
		ASSIGN.lastIndex = j;
		const a = ASSIGN.exec(s);
		if (a) {
			last = `${a[0]}…`;
			const end = wordEnd(s, j + a[0].length);
			const next = pastSeparator(s, end);
			i = next < 0 ? end : next; // `A=1 cmd`: the command follows on the same line
			continue;
		}
		CD.lastIndex = i;
		if (CD.exec(s)) {
			let k = i + 2;
			for (;;) {
				while (isBlank(s[k])) k++;
				if (k >= s.length || /[;&|\n]/.test(s[k] as string)) break;
				k = wordEnd(s, k);
			}
			const next = pastSeparator(s, k);
			if (next < 0) break; // `cd x | …`, `cd x || …`: the cd is the command
			last = s.slice(i, k).trim();
			i = next;
			continue;
		}
		break;
	}
	const rest = s.slice(i);
	const nl = rest.indexOf("\n");
	let first = collapse(nl < 0 ? rest : rest.slice(0, nl));
	// `(cd a && make)`, `{ make; }`: the group's closers go with its openers
	for (; opened > 0 && /[)}]\s*;?$/.test(first); opened--)
		first = first.replace(/\s*;?\s*[)}]\s*;?$/, "");
	if (!first) return collapse(last);
	// `A=1 B_C` at the very end: the hook's cut fell inside the next variable's name, not a command
	if (
		last.endsWith("=…") &&
		/^[A-Z_][A-Z0-9_]*$/.test(first) &&
		s.endsWith(first)
	)
		return collapse(last);
	// the program: its first word without quotes, the last part of its path, only if it is a plain name
	const head = first.slice(0, wordEnd(first, 0)).replace(/["'`]/g, "");
	const base = (head.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "");
	const program = PROGRAM.test(base) ? base : "";
	let script = false;
	const flag = C_INTERPRETER.test(program)
		? C_FLAG
		: /^php$/i.test(program)
			? PHP_FLAG
			: E_INTERPRETER.test(program)
				? E_FLAG
				: null;
	if (flag)
		for (const w of first.split(" ").slice(1)) {
			if (!w.startsWith("-")) break;
			if (flag.test(w)) {
				script = true;
				break;
			}
		}
	const doc = heredocAt(first);
	if (doc >= 0 && (flag || !program)) script = true;
	if (script) return program ? `${program} (스크립트)` : "(스크립트)";
	if (doc < 0) return first;
	// a heredoc fed to an ordinary program: the command up to it (`cat > a.md`, `git commit -m`)
	const before = first
		.slice(0, doc)
		.replace(/\s*"?\$\(\s*cat\s*$/, "")
		.trim();
	return before ? `${before} (스크립트)` : "(스크립트)";
}

/**
 * Where a heredoc starts in a line: the first `<<` that is not a here-string (`<<<`) and not inside quotes
 * (`--format='<<%h>>'`, `echo "a << b"`; a double quote left open, as in `-m "$(cat <<'EOF'`, does not
 * hide it); -1 when there is none. Linear.
 */
function heredocAt(line: string): number {
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"') {
			const close = line.indexOf('"', i + 1);
			if (close >= 0) i = close;
			continue;
		}
		if (c === "'") {
			const close = line.indexOf("'", i + 1);
			if (close < 0) return -1;
			i = close;
			continue;
		}
		if (c === "<" && line[i + 1] === "<") {
			if (line[i + 2] === "<") {
				i += 2;
				continue;
			}
			return i;
		}
	}
	return -1;
}

/**
 * Credential words a value may follow. Matched case-insensitively, not inside a longer word (`tokens`,
 * `secret.txt` and `token-store.ts` are not cut: the word must be followed by a separator).
 */
const CREDENTIAL =
	/(?<![A-Za-z])(?:password|passwd|passphrase|secret|auth[-_]?token|token|authorization|api[-_]?key|apikey|credentials?|bearer|cookie|private[-_]?key|access[-_]?key)(?=[\s=:'"+])/i;
/** `scheme://user:pw@host` with an empty user or a `/` in the password (redact() needs neither). */
const URL_PASSWORD =
	/(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{0,256}):[^\s@]{1,512}@/gi;
/** `curl -u user:pw`, `--user user:pw`, `sshpass -p pw` (single-dash and plain-name credentials). */
const USER_PASS =
	/((?:^|\s)(?:-u|--user)[\s=]{1,4}["']?[^\s:"']{0,256}):[^\s"']{1,512}/g;
const SSHPASS = /(\bsshpass\s{1,4}-p\s{0,4})\S{1,512}/g;

/**
 * The tail's last guard (INBOX-A 2026-11-13 B2 P1): `redact()` misses an unclosed quote
 * (`--password "x`), a custom auth scheme (`Authorization: Custom x`), PowerShell's `-Password 'x'` and
 * `password="x`, `NAME+=x`, `_authToken x`; also `-u user:pw` / `--user user:pw`, `sshpass -p pw` and a URL
 * password with an empty user or a `/` (A5 review shapes). On the always-on screen anything after a
 * credential word is dropped: the word stays (so
 * the line still says what ran), its `=` / `:` too, and the rest becomes `[REDACTED]`. A line where the
 * word has no value after it is left alone. Linear: one search with a fixed pattern.
 */
export function hideCredentials(input: string): string {
	const line = input
		.replace(URL_PASSWORD, "$1:[REDACTED]@")
		.replace(USER_PASS, "$1:[REDACTED]")
		.replace(SSHPASS, "$1[REDACTED]");
	const m = CREDENTIAL.exec(line);
	if (!m) return line;
	let end = m.index + m[0].length;
	const rest = line.slice(end);
	const sep = /^\s*\+?[=:]?/.exec(rest)?.[0] ?? "";
	end += sep.length;
	const value = line
		.slice(end)
		.replace(/^[\s'"]+/, "")
		.replace(/['"]+$/, "")
		.trim();
	if (value === "" || value === "[REDACTED]") return line;
	const head = line.slice(0, end).trimEnd();
	return `${head}${head.endsWith("=") ? "" : " "}[REDACTED]`;
}

/** The tail line one event makes, or null. */
export function tailLine(e: TailEvent, cwd: string | null): string | null {
	const summary = e.summary ?? "";
	let line: string | null;
	switch (e.type) {
		case "PreToolUse": {
			const tool = e.tool ?? "";
			const sub = /^(\S+) → ([\s\S]*)$/.exec(summary);
			if (sub && SUBAGENT_TOOLS.has(tool) && sub[1] === tool) {
				line = `→ ${collapse(sub[2] ?? "")}`;
			} else if (tool && summary.startsWith(`${tool}: `)) {
				const raw = summary.slice(tool.length + 2);
				const cmd = tool === "exec" ? codexCommand(raw) : raw;
				if (cmd === null) return null;
				const shown = commandLine(cmd);
				line = shown ? `$ ${shown}` : tool;
			} else if (tool && summary.startsWith(`${tool} `)) {
				line = `${tool} ${relPath(firstLine(summary.slice(tool.length + 1)), cwd)}`;
			} else line = tool || firstLine(summary) || null;
			break;
		}
		case "UserPromptSubmit": {
			const n = /\((\d+) chars\)/.exec(summary)?.[1];
			line = n ? `› 입력 (${n}자)` : "› 입력";
			break;
		}
		case "Notification":
			line = `! ${firstLine(summary) || "알림"}`;
			break;
		case "Stop":
			line = "■ 턴 끝";
			break;
		default:
			return null;
	}
	if (!line) return null;
	const safe = scrubPaths(hideCredentials(redact(line)), cwd);
	return safe.length > LINE_MAX ? `${safe.slice(0, LINE_MAX - 1)}…` : safe;
}

/**
 * Tail lines of one session's events (any order), oldest first so the newest is at the bottom; a run
 * of the same line is merged into one with its count. The last `max` are kept.
 */
export function tailLines(
	events: readonly TailEvent[],
	cwd: string | null,
	max: number = TAIL_MAX,
): TailLine[] {
	// oldest first; equal times keep the hub's order reversed (it lists newest first)
	const sorted = events
		.map((e, i) => ({ e, i }))
		.sort((a, b) => (a.e.ts < b.e.ts ? -1 : a.e.ts > b.e.ts ? 1 : b.i - a.i));
	const out: TailLine[] = [];
	for (const { e } of sorted) {
		const text = tailLine(e, cwd);
		if (text === null) continue;
		const last = out[out.length - 1];
		if (last && last.text === text) last.count++;
		else out.push({ text, count: 1 });
	}
	return max > 0 ? out.slice(-max) : [];
}

/**
 * Subagents still running in a session: subagent ids (`<session>/sub:<…>`, packages/schema ids.ts) that
 * started (PreToolUse of Task / Agent) with no PostToolUse of the same id in the window. A subagent sent
 * to the background gets its PostToolUse at once, so it is not counted (a known limit).
 */
export function runningSubagents(events: readonly TailEvent[]): number {
	const started = new Set<string>();
	const done = new Set<string>();
	for (const e of events) {
		if (!e.agent_id?.includes("/sub:")) continue;
		if (!e.tool || !SUBAGENT_TOOLS.has(e.tool)) continue;
		if (e.type === "PreToolUse") started.add(e.agent_id);
		else if (e.type === "PostToolUse") done.add(e.agent_id);
	}
	let n = 0;
	for (const id of started) if (!done.has(id)) n++;
	return n;
}

/**
 * `claude-opus-5-5` → `opus 5.5`, `claude-sonnet-4-20250514` → `sonnet 4`: the `claude-` prefix and a
 * date tail go; the name stays and the version's dashes become a dot. Anything else: its first 14
 * characters.
 */
export function shortModel(model: string | null | undefined): string | null {
	if (!model) return null;
	const m = /^(?:claude-)?([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(
		model,
	);
	if (m) return `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
	return model.slice(0, 14);
}
