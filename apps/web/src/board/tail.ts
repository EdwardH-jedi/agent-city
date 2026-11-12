// The terminal tail under a working session (design doc 15 §3.1): its last few tool events, one short
// line each, from the events the screen already has (useHub: /api/events?limit=200, then ws `event`) —
// no request of its own. Pure, no React. Only `type`, `tool`, `summary`, `agent_id`, `session_id` and
// `ts` are read; never `payload_redacted`. The collector has redacted every summary already; each line
// is redacted again here (two locks) and stripped of absolute paths: a path inside the session's folder
// becomes relative to it, any other absolute path keeps its last two parts. Command output and prompt
// text are not in the hub (decision D5), so they are never here either.
//
//   PreToolUse  `<tool>: <command>`      → `$ <command>` (first line, spaces collapsed)
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
		const rest = tailOf(m, 2);
		const space = /\s*$/.exec(m)?.[0] ?? "";
		return (rest ? `…/${rest}` : "~") + space;
	});
	return s.replace(ABS_IN_TEXT, (m) => {
		if (WEB_URL.test(m)) return m;
		const rest = tailOf(m.replace(/^file:\/\//i, ""), 0);
		return rest ? `…/${rest}` : "…";
	});
}

/**
 * Codex's script → the shell command in it: the string after `exec_command({cmd:` (key quoted or not,
 * `"`, `'` or `` ` `` quotes, spaces allowed), up to its first escaped newline. `write_stdin` only → null
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
			if (next === "n" || next === "r" || next === undefined) break;
			out += next;
			i++;
			continue;
		}
		if (ch === quote || ch === "\n") break;
		out += ch;
		if (out.length > LINE_MAX * 2) break;
	}
	return out;
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
				const first = firstLine(cmd);
				line = first ? `$ ${first}` : tool;
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
	const safe = scrubPaths(redact(line), cwd);
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
 * The tails and subagent counts of every session at once (one pass over the events). Recomputed when the
 * events change, not on the clock.
 */
export function sessionTails(
	events: readonly TailEvent[],
	cwdOf: (sessionId: string) => string | null,
	max: number = TAIL_MAX,
): Map<string, { lines: TailLine[]; subagents: number }> {
	const bySession = new Map<string, TailEvent[]>();
	for (const e of events) {
		if (!e.session_id) continue;
		const list = bySession.get(e.session_id);
		if (list) list.push(e);
		else bySession.set(e.session_id, [e]);
	}
	const out = new Map<string, { lines: TailLine[]; subagents: number }>();
	for (const [id, list] of bySession)
		out.set(id, {
			lines: tailLines(list, cwdOf(id), max),
			subagents: runningSubagents(list),
		});
	return out;
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
