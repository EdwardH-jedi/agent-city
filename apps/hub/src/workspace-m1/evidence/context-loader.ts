// Bounded, immutable context reads for decideDiffDisclosure: old/new versions come from git OBJECTS
// of two full commit ids (content-addressed; a worktree file that changes after the diff cannot be
// read by mistake). Per version: `ls-tree` (exact path, regular blob only — symlinks, submodules
// and trees are `special_file`), `cat-file -s` against the limits BEFORE any content is read, then
// `cat-file blob` capped at size + 1 and verified: exact byte length, no truncation, and the git
// blob id of the bytes equals the object id (so a lossy decode is caught, too).
//
// The git runner is injected (the hub's `gitRaw` is module-private — see the patch proposal); this
// module never logs, never returns stderr, and never puts content into an error.
import type { RunResult } from "../../managed/proc.ts";
import type { DiffFileRef } from "./diff-parse.ts";
import {
	type ContextSource,
	type ContextUnavailableReason,
	DEFAULT_DISCLOSURE_LIMITS,
	type FileContextEntry,
	gitBlobIds,
} from "./disclosure.ts";

/** Runs `git <global options> <args>` in the repository (argv only, bounded output). */
export type GitRunner = (
	args: readonly string[],
	maxOutputBytes: number,
) => Promise<
	Pick<
		RunResult,
		| "spawned"
		| "exitCode"
		| "timedOut"
		| "aborted"
		| "stdout"
		| "stdoutTruncated"
	>
>;

export interface ContextLoadLimits {
	max_files: number;
	max_file_bytes: number;
	max_total_bytes: number;
}

const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LS_TREE_MAX = 64 * 1024;

const unavailable = (reason: ContextUnavailableReason): ContextSource => ({
	kind: "unavailable",
	reason,
});

function pathOk(path: string): boolean {
	return (
		path.length > 0 &&
		path.length <= 4096 &&
		!path.includes("\0") &&
		!path.startsWith("/") &&
		!path.split("/").some((s) => s === "" || s === "." || s === "..")
	);
}

const ok = (r: Awaited<ReturnType<GitRunner>>) =>
	r.spawned && !r.timedOut && !r.aborted && r.exitCode === 0;

const failed = (r: Awaited<ReturnType<GitRunner>>): ContextUnavailableReason =>
	r.timedOut ? "timeout" : "unreadable";

/** Read one version (`rev:path`) as verified bytes, or say why not. */
export async function loadBlob(
	git: GitRunner,
	rev: string,
	path: string,
	maxBytes: number,
): Promise<ContextSource> {
	if (!FULL_OID.test(rev) || !pathOk(path)) return unavailable("bad_request");
	const ls = await git(
		["--literal-pathspecs", "ls-tree", "-z", "--full-tree", rev, "--", path],
		LS_TREE_MAX,
	);
	if (!ok(ls) || ls.stdoutTruncated) return unavailable(failed(ls));
	let entry: { mode: string; type: string; oid: string } | null = null;
	for (const rec of ls.stdout.split("\0")) {
		const m = /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40,64})\t([\s\S]*)$/.exec(rec);
		if (m && m[4] === path)
			entry = {
				mode: m[1] as string,
				type: m[2] as string,
				oid: m[3] as string,
			};
	}
	if (!entry) return unavailable("not_found");
	if (
		entry.type !== "blob" ||
		(entry.mode !== "100644" && entry.mode !== "100755") ||
		!FULL_OID.test(entry.oid)
	)
		return unavailable("special_file");

	const sz = await git(["cat-file", "-s", entry.oid], 64);
	if (!ok(sz) || sz.stdoutTruncated) return unavailable(failed(sz));
	const sm = /^(\d{1,12})\n?$/.exec(sz.stdout);
	if (!sm) return unavailable("unreadable");
	const size = Number(sm[1]);
	if (size > maxBytes) return unavailable("oversized");

	const blob = await git(["cat-file", "blob", entry.oid], size + 1);
	if (!ok(blob) || blob.stdoutTruncated) return unavailable(failed(blob));
	// the runner decodes stdout as UTF-8: a non-UTF-8 blob comes back altered — caught here
	const bytes = Buffer.from(blob.stdout, "utf8");
	if (bytes.length !== size) return unavailable("undecodable");
	const ids = gitBlobIds(bytes);
	if ((entry.oid.length === 40 ? ids.sha1 : ids.sha256) !== entry.oid)
		return unavailable("undecodable");
	return { kind: "bytes", bytes: new Uint8Array(bytes) };
}

/**
 * Old/new versions for every file of the diff that shows content (`needs_context`), read from the
 * commits `old_rev` (the diff base) and `new_rev` (the candidate). Sequential and bounded: files
 * beyond `max_files`, and versions beyond the total byte budget, are reported unavailable.
 */
export async function loadDiffContexts(
	git: GitRunner,
	refs: readonly DiffFileRef[],
	revs: { old_rev: string; new_rev: string },
	limits: Partial<ContextLoadLimits> = {},
): Promise<FileContextEntry[]> {
	const lim: ContextLoadLimits = {
		max_files: limits.max_files ?? DEFAULT_DISCLOSURE_LIMITS.max_files,
		max_file_bytes:
			limits.max_file_bytes ?? DEFAULT_DISCLOSURE_LIMITS.max_file_bytes,
		max_total_bytes:
			limits.max_total_bytes ??
			DEFAULT_DISCLOSURE_LIMITS.max_total_context_bytes,
	};
	let used = 0;
	const side = async (
		rev: string,
		path: string | null,
	): Promise<ContextSource> => {
		if (path === null) return { kind: "absent" };
		const room = Math.min(lim.max_file_bytes, lim.max_total_bytes - used);
		if (room < 0) return unavailable("oversized");
		const src = await loadBlob(git, rev, path, room);
		if (src.kind === "bytes") used += src.bytes.length;
		return src;
	};
	const out: FileContextEntry[] = [];
	for (const ref of refs.filter((r) => r.needs_context).slice(0, lim.max_files))
		out.push({
			old_path: ref.old_path,
			new_path: ref.new_path,
			old: await side(revs.old_rev, ref.old_path),
			new: await side(revs.new_rev, ref.new_path),
		});
	return out;
}
