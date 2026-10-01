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
		fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
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
