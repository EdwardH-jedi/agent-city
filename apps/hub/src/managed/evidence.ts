// Evidence for a candidate: artifact files on disk (+ a DB row each), the verification runs, and
// the manifest whose hash — together with the candidate SHA — a review is bound to.
//
// Artifact files live only under `<artifacts_root>/<task_id>/<run_id>/<name>`; names are generated
// here, and reads re-check the canonical path, so no request can name an arbitrary host file.
import type { Database } from "bun:sqlite";
import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
	type ArtifactKind,
	EVIDENCE_CONTRACT,
	EvidenceManifest,
	isSecretName,
	type ManagedArtifact,
	REDACTED,
	redact,
	type VerificationResult,
} from "@agent-city/schema";
import {
	canonicalJson,
	sha256Hex,
	type VerificationCommand,
} from "./config.ts";
import { isInside } from "./git.ts";
import { childEnv, type RunOptions, type RunResult } from "./proc.ts";
import { insertArtifact } from "./store.ts";

const SAFE_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const SAFE_ID = /^(task|run)-[0-9a-f-]{36}$/;
const KEY_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z ]{0,40}PRIVATE KEY-----/;

/** Longest piece handed to redact() at once (it clips at INPUT_MAX = 4096). */
const SEGMENT = 3_500;
/** A run of non-whitespace this long is not plausibly prose or code; it is masked whole. */
const UNBROKEN_MAX = 1_024;
/** `name: |` / `name: >-` … — a YAML block scalar header. */
const YAML_HEAD =
	/^([ \t]*)(?:-[ \t]+)?(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,63})\2[ \t]*:[ \t]*[|>][-+0-9]{0,2}[ \t]*$/;
const CONTINUED = /\\[ \t]*$/;

/** Drop a trailing partial word: what a byte cap cut off mid-token must not survive half-masked. */
export function dropTrailingFragment(text: string): string {
	const m = /[^\s"'=:,;]{1,4096}$/.exec(text);
	return m ? `${text.slice(0, m.index)}…` : text;
}

/** Last `max` characters without a leading partial word (for `tail`-style excerpts). */
export function clipTail(text: string, max: number): string {
	if (text.length <= max) return text;
	const tail = text.slice(-max);
	const m = /^[^\s"'=:,;]{1,4096}/.exec(tail);
	return `…${m ? tail.slice(m[0].length) : tail}`;
}

/** One logical line, any length, through redact() in whitespace-aligned segments. */
function redactLine(line: string): string {
	if (line.length <= SEGMENT) return redact(line);
	const parts: string[] = [];
	let rest = line;
	while (rest.length > SEGMENT) {
		const window = rest.slice(0, SEGMENT);
		const cut = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
		if (cut <= 0) {
			// no whitespace in the window: take the whole unbroken run
			const run = /^\S+/.exec(rest)?.[0] ?? window;
			parts.push(
				run.length > UNBROKEN_MAX
					? `${REDACTED}(long unbroken text)`
					: redact(run),
			);
			rest = rest.slice(run.length);
		} else {
			parts.push(redact(rest.slice(0, cut)));
			rest = rest.slice(cut);
		}
	}
	parts.push(redact(rest));
	return parts.join("");
}

/**
 * Redact a whole log / diff (any size) without losing the multi-line protections redact() has for
 * a single string: CRLF/LF line splitting; private-key blocks dropped through their END line; YAML
 * block scalars under a secret-looking key masked as a unit; backslash-continued lines joined
 * (bounded) before matching, so a token split by `\` + newline is still recognised; long lines
 * redacted in whitespace-aligned segments instead of being silently clipped at 4 KB. With
 * `truncated`, a trailing partial token left by a byte cap is dropped.
 */
export function redactLog(
	text: string,
	o: { truncated?: boolean } = {},
): string {
	const src = o.truncated ? dropTrailingFragment(text) : text;
	const lines = src.split(/\r?\n/);
	const out: string[] = [];
	let inKey = false;
	let yamlIndent: number | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		if (inKey) {
			if (KEY_END.test(line)) inKey = false;
			continue;
		}
		if (yamlIndent !== null) {
			const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
			if (line.trim() === "" || indent > yamlIndent) continue; // still inside the block
			yamlIndent = null;
		}
		if (KEY_BEGIN.test(line)) {
			out.push(REDACTED);
			inKey = !KEY_END.test(line);
			continue;
		}
		const head = YAML_HEAD.exec(line);
		if (head && isSecretName(head[3] ?? "")) {
			out.push(redactLine(line), `${head[1] ?? ""}  ${REDACTED}`);
			yamlIndent = (head[1] ?? "").length;
			continue;
		}
		if (CONTINUED.test(line)) {
			// join `\`-continued lines (bounded) and redact them as one unit
			let joined = line;
			let j = i;
			while (
				CONTINUED.test(joined) &&
				j + 1 < lines.length &&
				j - i < 20 &&
				joined.length < 8_000
			) {
				j++;
				joined =
					joined.replace(CONTINUED, "") +
					(lines[j] as string).replace(/^[ \t]+/, "");
			}
			out.push(redactLine(joined));
			i = j;
			continue;
		}
		out.push(redactLine(line));
	}
	return out.join("\n");
}

/**
 * redactLog's multi-line protections over ONE file version, line for line: output i belongs to
 * input line i (null = a private-key body line, dropped). A `\`-continued chain is joined (same
 * bounds as redactLog) and redacted as one unit; if that masks anything, each line of the chain
 * keeps only its text before the first masked position.
 */
function maskVersion(lines: readonly string[]): (string | null)[] {
	const out: (string | null)[] = [];
	let inKey = false;
	let yamlIndent: number | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		if (inKey) {
			out.push(null);
			if (KEY_END.test(line)) inKey = false;
			continue;
		}
		if (yamlIndent !== null) {
			const ws = /^[ \t]*/.exec(line)?.[0] ?? "";
			if (line.trim() === "") {
				out.push(line);
				continue;
			}
			if (ws.length > yamlIndent) {
				out.push(`${ws}${REDACTED}`); // still inside the block
				continue;
			}
			yamlIndent = null;
		}
		if (KEY_BEGIN.test(line)) {
			out.push(REDACTED);
			inKey = !KEY_END.test(line);
			continue;
		}
		const head = YAML_HEAD.exec(line);
		if (head && isSecretName(head[3] ?? "")) {
			out.push(redactLine(line));
			yamlIndent = (head[1] ?? "").length;
			continue;
		}
		if (!CONTINUED.test(line)) {
			out.push(redactLine(line));
			continue;
		}
		const segs = [{ lead: 0, text: line }];
		let j = i;
		let len = line.length;
		for (;;) {
			const last = segs[segs.length - 1] as { lead: number; text: string };
			if (
				!CONTINUED.test(last.text) ||
				j + 1 >= lines.length ||
				j - i >= 20 ||
				len >= 8_000
			)
				break;
			last.text = last.text.replace(CONTINUED, "");
			j++;
			const next = lines[j] as string;
			const lead = /^[ \t]*/.exec(next)?.[0].length ?? 0;
			segs.push({ lead, text: next.slice(lead) });
			len += next.length - lead;
		}
		const joined = segs.map((s) => s.text).join("");
		const masked = redactLine(joined);
		if (masked === joined) {
			for (let k = i; k <= j; k++) out.push(redactLine(lines[k] as string));
		} else {
			let keep = 0;
			while (keep < joined.length && joined[keep] === masked[keep]) keep++;
			let offset = 0;
			segs.forEach((s, k) => {
				const orig = lines[i + k] as string;
				const end = offset + s.text.length;
				out.push(
					end <= keep
						? orig
						: `${orig.slice(0, s.lead + Math.max(0, keep - offset))}${REDACTED}`,
				);
				offset = end;
			});
		}
		i = j;
	}
	return out;
}

/**
 * Redact a unified diff (`git diff` output) with the same protections as redactLog. Line prefixes
 * (`+`, `-`, ` `) would hide a YAML block or a `\`-continued token from line-based detection, and a
 * secret's lines may be split between context and changed lines. So per file, the two versions the
 * diff shows — context + removed lines, context + added lines — are each analysed as text without
 * prefixes, and the result is mapped back onto the original lines with their prefixes. A context
 * line the two versions mask differently is masked whole. Headers (`diff --git`, `---`, `+++`,
 * `@@ …`) are redacted line by line; line structure is kept (only key-block bodies are dropped).
 */
export function redactDiff(
	text: string,
	o: { truncated?: boolean } = {},
): string {
	const src = o.truncated ? dropTrailingFragment(text) : text;
	const lines = src.split(/\r?\n/);
	const out: (string | null)[] = lines.map(() => null);
	let file: number[] = []; // content-line indices of the current file
	let inHunk = false;
	const content = (i: number) => (lines[i] as string).slice(1);
	const flush = () => {
		const oldIdx = file.filter((i) => !(lines[i] as string).startsWith("+"));
		const newIdx = file.filter((i) => !(lines[i] as string).startsWith("-"));
		const oldOut = maskVersion(oldIdx.map(content));
		const newOut = maskVersion(newIdx.map(content));
		const oldOf = new Map(oldIdx.map((li, k) => [li, oldOut[k] ?? null]));
		const newOf = new Map(newIdx.map((li, k) => [li, newOut[k] ?? null]));
		for (const li of file) {
			const line = lines[li] as string;
			const p = line.slice(0, 1);
			let v: string | null;
			if (p === "+") v = newOf.get(li) ?? null;
			else if (p === "-") v = oldOf.get(li) ?? null;
			else {
				const a = oldOf.get(li) ?? null;
				const b = newOf.get(li) ?? null;
				v =
					a === b
						? a
						: a === null || b === null
							? null
							: `${/^[ \t]*/.exec(content(li))?.[0] ?? ""}${REDACTED}`;
			}
			out[li] = v === null ? null : line === "" ? "" : `${p}${v}`;
		}
		file = [];
	};
	lines.forEach((line, i) => {
		if (line.startsWith("diff --git ")) {
			flush();
			inHunk = false;
		} else if (line.startsWith("@@")) inHunk = true;
		else if (
			inHunk &&
			(line === "" || line[0] === "+" || line[0] === "-" || line[0] === " ")
		) {
			file.push(i);
			return;
		} else if (inHunk && line.startsWith("\\")) {
			out[i] = line; // "\ No newline at end of file"
			return;
		}
		out[i] = redactLine(line);
	});
	flush();
	return out.filter((l): l is string => l !== null).join("\n");
}

export interface ArtifactInput {
	task_id: string;
	run_id: string;
	kind: ArtifactKind;
	name: string;
	content: string;
	truncated?: boolean;
	candidate_sha: string | null;
	meta?: Record<string, unknown>;
	now: string;
}

/** Write the file, then the row. Call inside the caller's fenced transaction when one is needed. */
export function writeArtifact(
	db: Database,
	root: string,
	a: ArtifactInput,
): ManagedArtifact {
	if (
		!SAFE_NAME.test(a.name) ||
		!SAFE_ID.test(a.task_id) ||
		!SAFE_ID.test(a.run_id)
	)
		throw new Error("unsafe artifact name");
	const rel = join(a.task_id, a.run_id, a.name);
	const abs = join(root, rel);
	mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
	const bytes = Buffer.from(a.content, "utf8");
	writeFileSync(abs, bytes, { mode: 0o600 });
	return insertArtifact(db, {
		task_id: a.task_id,
		run_id: a.run_id,
		kind: a.kind,
		name: a.name,
		rel_path: rel,
		sha256: sha256Hex(bytes),
		byte_len: bytes.length,
		truncated: a.truncated ?? false,
		candidate_sha: a.candidate_sha,
		meta: a.meta ?? {},
		created_at: a.now,
	});
}

/**
 * `not_found`: no such artifact inside the root (or the row points outside it).
 * `integrity`: the artifact exists but its stored bytes are not the recorded bytes (changed,
 * truncated, replaced by a symlink, unreadable) — it must not be shown or used as evidence.
 */
export class ArtifactAccessError extends Error {
	constructor(
		readonly code: "not_found" | "integrity",
		message: string,
	) {
		super(message);
		this.name = "ArtifactAccessError";
	}
}

/**
 * open() flags for reading a file another party could have replaced: no symlink is followed, and
 * O_NONBLOCK makes the open itself return at once for a FIFO / device (a blocking open of a FIFO
 * without a writer would freeze the whole hub, timers included). The descriptor is then validated
 * with fstat — never a separate stat of the path. On a regular file O_NONBLOCK changes nothing.
 */
export const SAFE_READ_FLAGS =
	constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Hard cap on one artifact read (artifacts are written bounded far below this). */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

/**
 * Read the FULL stored bytes of an artifact and verify them against the row (byte_len + sha256)
 * before anyone uses them. The returned buffer is the one that was verified — callers check and
 * consume the same bytes, never a second read. Path rules: inside the artifacts root, no symlink
 * at the file, a regular file, opened with O_NOFOLLOW.
 */
export function readArtifactBytes(
	root: string,
	artifact: Pick<ManagedArtifact, "rel_path" | "byte_len" | "sha256" | "name">,
): Buffer {
	// A row is generated as `<task>/<run>/<name>`; anything absolute or with `..` was tampered with.
	if (
		isAbsolute(artifact.rel_path) ||
		artifact.rel_path.split(/[\\/]/).includes("..")
	)
		throw new ArtifactAccessError("not_found", "outside the artifacts root");
	const abs = join(root, artifact.rel_path);
	let realRoot: string;
	try {
		realRoot = realpathSync(root);
	} catch {
		throw new ArtifactAccessError("not_found", "artifacts root is missing");
	}
	let realParent: string;
	try {
		realParent = realpathSync(dirname(abs));
	} catch {
		throw new ArtifactAccessError(
			"integrity",
			`${artifact.name}: file is missing`,
		);
	}
	const real = join(realParent, basename(abs));
	if (!isInside(realRoot, realParent) || real === realRoot)
		throw new ArtifactAccessError("not_found", "outside the artifacts root");
	let fd: number;
	try {
		fd = openSync(real, SAFE_READ_FLAGS);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		throw new ArtifactAccessError(
			"integrity",
			`${artifact.name}: ${code === "ELOOP" ? "replaced by a symlink" : code === "ENOENT" ? "file is missing" : "cannot be opened"}`,
		);
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile())
			throw new ArtifactAccessError(
				"integrity",
				`${artifact.name}: not a regular file`,
			);
		if (st.size !== artifact.byte_len)
			throw new ArtifactAccessError(
				"integrity",
				`${artifact.name}: size ${st.size} B, recorded ${artifact.byte_len} B`,
			);
		if (st.size > MAX_ARTIFACT_BYTES)
			throw new ArtifactAccessError(
				"integrity",
				`${artifact.name}: too large to verify`,
			);
		const buf = Buffer.alloc(st.size);
		let off = 0;
		while (off < buf.length) {
			const n = readSync(fd, buf, off, buf.length - off, off);
			if (n <= 0) break; // short read: caught by the length check below
			off += n;
		}
		if (off !== buf.length)
			throw new ArtifactAccessError(
				"integrity",
				`${artifact.name}: short read`,
			);
		if (sha256Hex(buf) !== artifact.sha256)
			throw new ArtifactAccessError(
				"integrity",
				`${artifact.name}: content does not match its recorded sha256`,
			);
		return buf;
	} finally {
		closeSync(fd);
	}
}

/** Verified artifact as text; only a display prefix of at most `maxBytes` is returned. */
export function readArtifact(
	root: string,
	artifact: Pick<ManagedArtifact, "rel_path" | "byte_len" | "sha256" | "name">,
	maxBytes: number,
): { text: string; truncated: boolean } {
	const buf = readArtifactBytes(root, artifact);
	return {
		text: buf.subarray(0, maxBytes).toString("utf8"),
		truncated: buf.length > maxBytes,
	};
}

export class EvidenceError extends Error {
	constructor(readonly problems: string[]) {
		super(problems.join("; "));
		this.name = "EvidenceError";
	}
}

export interface VerifiedEvidence {
	manifest: EvidenceManifest;
	/** The verified diff bytes, decoded once. */
	diff: string;
}

const verifyName = (i: number, name: string) => `verify-${i + 1}-${name}.log`;

/**
 * Check a run's evidence as one unit: every artifact's bytes match its row, the manifest's bytes
 * hash to the run's manifest_hash, and the manifest's references (diff_sha256, each verification
 * log_sha256) match the artifacts that are actually stored. Returns the verified manifest + diff.
 */
export function verifyRunEvidence(
	root: string,
	artifacts: readonly ManagedArtifact[],
	expected: { manifest_hash: string; candidate_sha: string },
): VerifiedEvidence {
	const problems: string[] = [];
	const bytes = new Map<string, Buffer>();
	for (const a of artifacts) {
		try {
			bytes.set(a.name, readArtifactBytes(root, a));
		} catch (err) {
			problems.push((err as Error).message);
		}
	}
	const manifestBuf = bytes.get("manifest.json");
	let manifest: EvidenceManifest | null = null;
	if (!artifacts.some((a) => a.name === "manifest.json"))
		problems.push("manifest.json: missing");
	else if (manifestBuf) {
		if (sha256Hex(manifestBuf) !== expected.manifest_hash)
			problems.push("manifest.json: does not hash to the run's manifest_hash");
		try {
			const parsed = EvidenceManifest.safeParse(
				JSON.parse(manifestBuf.toString("utf8")),
			);
			if (parsed.success) manifest = parsed.data;
			else problems.push("manifest.json: not a valid evidence manifest");
		} catch {
			problems.push("manifest.json: not JSON");
		}
	}
	if (manifest) {
		if (manifest.candidate_sha !== expected.candidate_sha)
			problems.push("manifest.json: names a different candidate");
		const diffArt = artifacts.find((a) => a.name === "diff.patch");
		if (!diffArt) problems.push("diff.patch: missing");
		else if (diffArt.sha256 !== manifest.diff_sha256)
			problems.push("diff.patch: not the diff the manifest names");
		manifest.verification.forEach((v, i) => {
			const art = artifacts.find((a) => a.name === verifyName(i, v.name));
			if (!art) problems.push(`${verifyName(i, v.name)}: missing`);
			else if (art.sha256 !== v.log_sha256)
				problems.push(
					`${verifyName(i, v.name)}: not the log the manifest names`,
				);
		});
	}
	const diffBuf = bytes.get("diff.patch");
	if (problems.length > 0 || !manifest || !diffBuf)
		throw new EvidenceError(
			problems.length ? problems : ["evidence incomplete"],
		);
	return { manifest, diff: diffBuf.toString("utf8") };
}

/** Integrity of every stored artifact of a run (for display): never throws. */
export function evidenceProblems(
	root: string,
	artifacts: readonly ManagedArtifact[],
	expected: { manifest_hash: string | null; candidate_sha: string | null },
): string[] {
	if (!expected.manifest_hash || !expected.candidate_sha) {
		const problems: string[] = [];
		for (const a of artifacts)
			try {
				readArtifactBytes(root, a);
			} catch (err) {
				problems.push((err as Error).message);
			}
		return problems;
	}
	try {
		verifyRunEvidence(root, artifacts, {
			manifest_hash: expected.manifest_hash,
			candidate_sha: expected.candidate_sha,
		});
		return [];
	} catch (err) {
		return err instanceof EvidenceError
			? err.problems
			: [(err as Error).message];
	}
}

// ── verification ────────────────────────────────────────────────────────────

export interface VerificationRun {
	result: VerificationResult;
	log: string;
}

/**
 * Run one trusted verification command (argv from the config, never from a task or a model) in the
 * worktree. A command that did not run to completion is recorded as such — it is not a pass and it
 * is not evidence that the code is bad.
 */
export async function runVerification(
	cmd: VerificationCommand,
	worktree: string,
	run: (
		opts: Pick<RunOptions, "argv" | "cwd" | "env" | "timeoutMs">,
	) => Promise<RunResult>,
): Promise<VerificationRun> {
	const r = await run({
		argv: cmd.argv,
		cwd: worktree,
		env: childEnv(),
		timeoutMs: cmd.timeout_s * 1000,
	});
	const header = r.spawned
		? `exit=${r.exitCode ?? "none"} signal=${r.signal ?? "none"} timed_out=${r.timedOut} aborted=${r.aborted}`
		: `not started: ${r.spawnError ?? "unknown"}`;
	const log = redactLog(
		[
			`# ${cmd.name}: ${header}`,
			"## stdout",
			r.stdoutTruncated ? dropTrailingFragment(r.stdout) : r.stdout,
			"## stderr",
			r.stderrTruncated ? dropTrailingFragment(r.stderr) : r.stderr,
		].join("\n"),
	);
	return {
		log,
		result: {
			name: cmd.name,
			argv: [...cmd.argv],
			exit_code: r.exitCode,
			completed: r.spawned && !r.timedOut && !r.aborted && r.exitCode !== null,
			timed_out: r.timedOut,
			duration_ms: r.durationMs,
			log_sha256: sha256Hex(log),
			log_truncated: r.stdoutTruncated || r.stderrTruncated,
		},
	};
}

// ── manifest ────────────────────────────────────────────────────────────────

export type ManifestInput = Omit<EvidenceManifest, "contract">;

export function buildManifest(input: ManifestInput): {
	manifest: EvidenceManifest;
	json: string;
	hash: string;
} {
	const manifest = EvidenceManifest.parse({
		contract: EVIDENCE_CONTRACT,
		...input,
	});
	const json = canonicalJson(manifest);
	return { manifest, json, hash: sha256Hex(json) };
}
