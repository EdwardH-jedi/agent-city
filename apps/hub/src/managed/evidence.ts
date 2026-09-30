// Evidence for a candidate: artifact files on disk (+ a DB row each), the verification runs, and
// the manifest whose hash — together with the candidate SHA — a review is bound to.
//
// Artifact files live only under `<artifacts_root>/<task_id>/<run_id>/<name>`; names are generated
// here, and reads re-check the canonical path, so no request can name an arbitrary host file.
import type { Database } from "bun:sqlite";
import {
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	type ArtifactKind,
	EVIDENCE_CONTRACT,
	EvidenceManifest,
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

/**
 * Redact a log / diff line by line (redact() clips one string at 4 KB, so a whole log cannot go
 * through it at once). A private-key block is dropped through its END line.
 */
export function redactLog(text: string): string {
	const out: string[] = [];
	let inKey = false;
	for (const line of text.split("\n")) {
		if (inKey) {
			if (KEY_END.test(line)) inKey = false;
			continue;
		}
		if (KEY_BEGIN.test(line)) {
			out.push(REDACTED);
			inKey = !KEY_END.test(line);
			continue;
		}
		out.push(redact(line));
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

export class ArtifactAccessError extends Error {}

/**
 * Read a stored artifact. The row's rel_path is resolved, canonicalized and required to be a
 * regular file inside the artifacts root (no symlink, no `..`), whatever the row says.
 */
export function readArtifact(
	root: string,
	artifact: Pick<ManagedArtifact, "rel_path">,
	maxBytes: number,
): { text: string; truncated: boolean } {
	const abs = join(root, artifact.rel_path);
	let real: string;
	let realRoot: string;
	try {
		if (lstatSync(abs).isSymbolicLink())
			throw new ArtifactAccessError("symlink");
		real = realpathSync(abs);
		realRoot = realpathSync(root);
	} catch (err) {
		if (err instanceof ArtifactAccessError) throw err;
		throw new ArtifactAccessError("missing");
	}
	if (real === realRoot || !isInside(realRoot, real))
		throw new ArtifactAccessError("outside the artifacts root");
	const st = lstatSync(real);
	if (!st.isFile()) throw new ArtifactAccessError("not a file");
	const len = Math.min(st.size, maxBytes);
	const buf = Buffer.alloc(len);
	const fd = openSync(real, "r");
	try {
		readSync(fd, buf, 0, len, 0);
	} finally {
		closeSync(fd);
	}
	return { text: buf.toString("utf8"), truncated: st.size > maxBytes };
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
			r.stdout,
			"## stderr",
			r.stderr,
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
