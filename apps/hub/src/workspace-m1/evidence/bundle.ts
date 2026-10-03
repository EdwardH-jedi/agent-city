// Durable accepted evidence (contract delta v1.2 §B): the `agentcity.evidence-bundle/v1` file.
//
// Format: one header line (canonical JSON {contract, result_envelope_hash, managed_task_id, run_id,
// items: [{name, artifact_id, sha256, byte_len, offset}]}) + "\n" + the item bytes concatenated in
// header order. Items = every envelope artifact whose status is `verified` or `truncated`, built from
// the EXACT buffers the sealer read and hashed (never re-read for the bundle). Identity: digest =
// sha256(whole file); location `<artifacts_root>/_sealed/<digest>.bundle` (dir 0700, file 0600).
//
// Who writes: only the bridge reconciler (and the decisions test emulation of it), at Gate-2
// opening, BEFORE the result request row is inserted. Publication is atomic: exclusive no-follow
// temp file in `_sealed`, write, fsync, rename to the content address, fsync the directory. An
// existing target must be byte-equal (content address) or publication fails; nothing is ever
// republished from re-read bytes.
//
// Who reads: `verifyBundle` — the same discipline as `readArtifactBytes` (no-follow, non-blocking
// open, fstat of the descriptor = regular file, bounded size and time, one read), then sha256(file)
// = digest, strict canonical header, binding to the request's envelope (hash, task, run, and the
// exact verified/truncated item list) and every slice hashed against its item. Fixed failure codes
// only; nothing here logs or returns content outside the verified slices.
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import {
	ArtifactId,
	EVIDENCE_BUNDLE_CONTRACT,
	type EvidenceBundleRow,
	type EvidenceStatus,
	Hash,
	ManagedTaskId,
	type ResultEnvelope,
	RunId,
	type SealedResult,
} from "@agent-city/schema/workspace-m1";
import { canonicalEncode } from "@agent-city/schema/workspace-m1/hash";
import { z } from "zod";
import { SAFE_READ_FLAGS } from "../../managed/evidence.ts";

/** Directory under the artifacts root that holds the bundles (hub-owned, outside worktrees). */
export const SEALED_DIR = "_sealed";
/** Header line cap (64 items × a few hundred bytes fits with a wide margin). */
export const MAX_BUNDLE_HEADER_BYTES = 64 * 1024;
/** Default bundle cap: the sealer's total evidence budget (64 MiB) + the header. */
export const DEFAULT_MAX_BUNDLE_BYTES =
	64 * 1024 * 1024 + MAX_BUNDLE_HEADER_BYTES;
const MAX_ITEMS = 64;
const DIGEST = /^[0-9a-f]{64}$/;

/** v1.2 §B wording for a pending Gate-2 request recorded before durable evidence existed. */
export const LEGACY_RESULT_DETAIL =
	"legacy result without durable evidence; a new proposal and approval are required";
/** v1.2 §A wording for a result of a legacy v1 proposal (no criterion coverage; criteria_unmapped). */
export const LEGACY_PROPOSAL_DETAIL =
	"the result belongs to a legacy proposal without criterion coverage (criteria_unmapped); a new proposal and approval are required";
/** v1.2 §B wording when the durable bundle could not be published at Gate-2 opening. */
export const DURABLE_SEAL_FAILED_DETAIL = "durable evidence seal failed";

export const bundleRelPath = (digest: string) =>
	`${SEALED_DIR}/${digest}.bundle`;

const sha256Hex = (b: Uint8Array) =>
	createHash("sha256").update(b).digest("hex");

/** The envelope fields a bundle binds to (structural: every result contract version has them). */
export type BundleEnvelope = Pick<
	ResultEnvelope,
	"artifacts" | "managed_task_id" | "run_id"
>;

const RETAINED: ReadonlySet<EvidenceStatus> = new Set([
	"verified",
	"truncated",
]);

/** The envelope artifacts a bundle must hold, in envelope order. */
export function bundledArtifacts(envelope: BundleEnvelope) {
	return envelope.artifacts.filter(
		(a) =>
			RETAINED.has(a.status) &&
			a.artifact_id !== null &&
			a.sha256 !== null &&
			a.byte_len !== null,
	) as (BundleEnvelope["artifacts"][number] & {
		artifact_id: string;
		sha256: string;
		byte_len: number;
	})[];
}

// ── the sealer's verified buffers (attached to its SealedResult, never re-read) ──────────────

export interface SealedEvidenceItem {
	artifact_id: string;
	name: string;
	sha256: string;
	byte_len: number;
	status: EvidenceStatus;
	/** The buffer `readArtifactBytes` returned and the seal hashed (verified against the row). */
	buffer: Buffer;
}

export interface SealedEvidence {
	envelope_hash: string;
	managed_task_id: string;
	run_id: string;
	items: readonly SealedEvidenceItem[];
}

const SEALED = new WeakMap<object, SealedEvidence>();

/** Called by the sealer: the verified buffers behind exactly this SealedResult object. */
export function attachSealedEvidence(
	result: SealedResult,
	evidence: SealedEvidence,
): void {
	SEALED.set(result, evidence);
}

/** The sealer's buffers for this result, or null (not produced by the sealer, or a copy of one). */
export function sealedEvidenceOf(result: SealedResult): SealedEvidence | null {
	return SEALED.get(result) ?? null;
}

// ── build ───────────────────────────────────────────────────────────────────

const BundleHeaderItem = z.strictObject({
	name: z.string().min(1).max(200),
	artifact_id: ArtifactId,
	sha256: Hash,
	byte_len: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const BundleHeader = z.strictObject({
	contract: z.literal(EVIDENCE_BUNDLE_CONTRACT),
	result_envelope_hash: Hash,
	managed_task_id: ManagedTaskId,
	run_id: RunId,
	items: z.array(BundleHeaderItem).max(MAX_ITEMS),
});
export type BundleHeader = z.infer<typeof BundleHeader>;

export type BundleBuildCode =
	| "no_sealed_buffers"
	| "envelope_mismatch"
	| "buffer_mismatch"
	| "too_large";

export class BundleError extends Error {
	constructor(
		readonly code:
			| BundleBuildCode
			| "root_unavailable"
			| "sealed_dir_invalid"
			| "write_failed"
			| "target_conflict",
	) {
		super(`evidence bundle: ${code}`);
		this.name = "BundleError";
	}
}

export interface BuiltBundle {
	digest: string;
	bytes: Buffer;
	header: BundleHeader;
}

/**
 * Build the bundle of a sealed result from the sealer's own buffers. Every buffer is re-hashed
 * against its item and the item list must equal the envelope's verified/truncated artifacts exactly.
 */
export function buildBundle(
	sealed: SealedResult,
	max_bytes = DEFAULT_MAX_BUNDLE_BYTES,
): BuiltBundle {
	const ev = sealedEvidenceOf(sealed);
	if (!ev) throw new BundleError("no_sealed_buffers");
	const env = sealed.envelope;
	if (
		ev.envelope_hash !== sealed.envelope_hash ||
		ev.managed_task_id !== env.managed_task_id ||
		ev.run_id !== env.run_id
	)
		throw new BundleError("envelope_mismatch");
	const expected = bundledArtifacts(env);
	const kept = ev.items.filter((i) => RETAINED.has(i.status));
	if (kept.length !== expected.length || expected.length > MAX_ITEMS)
		throw new BundleError("envelope_mismatch");
	const items: BundleHeader["items"] = [];
	const buffers: Buffer[] = [];
	let offset = 0;
	for (const a of expected) {
		const it = kept.find((i) => i.artifact_id === a.artifact_id);
		if (
			!it ||
			it.name !== a.name ||
			it.sha256 !== a.sha256 ||
			it.byte_len !== a.byte_len ||
			it.status !== a.status
		)
			throw new BundleError("envelope_mismatch");
		if (it.buffer.length !== it.byte_len || sha256Hex(it.buffer) !== it.sha256)
			throw new BundleError("buffer_mismatch");
		items.push({
			name: a.name,
			artifact_id: a.artifact_id,
			sha256: a.sha256,
			byte_len: a.byte_len,
			offset,
		});
		buffers.push(it.buffer);
		offset += it.byte_len;
	}
	const header: BundleHeader = BundleHeader.parse({
		contract: EVIDENCE_BUNDLE_CONTRACT,
		result_envelope_hash: sealed.envelope_hash,
		managed_task_id: env.managed_task_id,
		run_id: env.run_id,
		items,
	});
	const line = Buffer.from(`${canonicalEncode(header)}\n`, "utf8");
	if (line.length > MAX_BUNDLE_HEADER_BYTES) throw new BundleError("too_large");
	if (line.length + offset > max_bytes) throw new BundleError("too_large");
	const bytes = Buffer.concat([line, ...buffers]);
	return { digest: sha256Hex(bytes), bytes, header };
}

// ── publish ─────────────────────────────────────────────────────────────────

/** Test-only fault points (never set in production). */
export interface PublishFaults {
	/** After the temp file is fully written + fsynced, before the rename (throw = crash here). */
	beforeRename?(tmp_path: string): void;
}

function realSealedDir(artifactsRoot: string, create: boolean): string {
	let root: string;
	try {
		root = realpathSync(artifactsRoot);
	} catch {
		throw new BundleError("root_unavailable");
	}
	const dir = join(root, SEALED_DIR);
	if (create) {
		try {
			mkdirSync(dir, { mode: 0o700 });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST")
				throw new BundleError("sealed_dir_invalid");
		}
	}
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(dir);
	} catch {
		throw new BundleError("sealed_dir_invalid");
	}
	// a symlinked / replaced `_sealed` is never followed
	if (st.isSymbolicLink() || !st.isDirectory())
		throw new BundleError("sealed_dir_invalid");
	return dir;
}

/** One bounded, no-follow, non-blocking read of a regular file (null: not a readable regular file). */
function safeReadFile(path: string, max: number): Buffer | null {
	let fd: number;
	try {
		fd = openSync(path, SAFE_READ_FLAGS);
	} catch {
		return null;
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile() || st.size > max) return null;
		const buf = Buffer.alloc(st.size);
		let off = 0;
		while (off < buf.length) {
			const n = readSync(fd, buf, off, buf.length - off, off);
			if (n <= 0) break;
			off += n;
		}
		return off === buf.length ? buf : null;
	} finally {
		closeSync(fd);
	}
}

/**
 * Atomically publish a built bundle under `<artifacts_root>/_sealed/<digest>.bundle`. Idempotent for
 * the same content; an existing target with other bytes (or not a regular file) fails.
 */
export function publishBundle(
	artifactsRoot: string,
	built: BuiltBundle,
	faults?: PublishFaults,
): { rel_path: string; byte_len: number } {
	if (!DIGEST.test(built.digest)) throw new BundleError("write_failed");
	const dir = realSealedDir(artifactsRoot, true);
	const target = join(dir, `${built.digest}.bundle`);
	let exists = true;
	try {
		lstatSync(target);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT")
			throw new BundleError("write_failed");
		exists = false;
	}
	if (exists) {
		const prior = safeReadFile(target, built.bytes.length);
		if (prior?.equals(built.bytes))
			return {
				rel_path: bundleRelPath(built.digest),
				byte_len: built.bytes.length,
			};
		throw new BundleError("target_conflict");
	}
	const tmp = join(dir, `.tmp-${randomUUID()}`);
	let fd: number;
	try {
		fd = openSync(
			tmp,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
	} catch {
		throw new BundleError("write_failed");
	}
	try {
		let off = 0;
		while (off < built.bytes.length)
			off += writeSync(fd, built.bytes, off, built.bytes.length - off);
		fsyncSync(fd);
	} catch {
		closeSync(fd);
		rmSync(tmp, { force: true });
		throw new BundleError("write_failed");
	}
	closeSync(fd);
	try {
		faults?.beforeRename?.(tmp);
		renameSync(tmp, target);
	} catch {
		rmSync(tmp, { force: true });
		throw new BundleError("write_failed");
	}
	try {
		const dfd = openSync(dir, constants.O_RDONLY);
		try {
			fsyncSync(dfd);
		} finally {
			closeSync(dfd);
		}
	} catch {
		throw new BundleError("write_failed");
	}
	return {
		rel_path: bundleRelPath(built.digest),
		byte_len: built.bytes.length,
	};
}

/**
 * Build + publish the bundle of a sealed (eligible) result and return its row (to be inserted in
 * the SAME transaction as the result request that names it). Throws BundleError on any failure.
 */
export function publishSealedEvidence(
	artifactsRoot: string,
	sealed: SealedResult,
	created_at: string,
	faults?: PublishFaults,
): EvidenceBundleRow {
	const built = buildBundle(sealed);
	const pub = publishBundle(artifactsRoot, built, faults);
	return {
		digest: built.digest,
		result_envelope_hash: sealed.envelope_hash,
		managed_task_id: sealed.envelope.managed_task_id,
		run_id: sealed.envelope.run_id,
		rel_path: pub.rel_path,
		byte_len: pub.byte_len,
		item_count: built.header.items.length,
		created_at,
	};
}

// ── verify ──────────────────────────────────────────────────────────────────

export type BundleFailureCode =
	| "bundle_missing"
	| "bundle_not_regular"
	| "bundle_oversized"
	| "bundle_hash_mismatch"
	| "bundle_header_invalid"
	| "bundle_binding_mismatch"
	| "bundle_unreadable";

export interface VerifiedBundleItem {
	artifact_id: string;
	name: string;
	sha256: string;
	byte_len: number;
	/** The status recorded for this item in the sealed envelope (verified | truncated). */
	status: EvidenceStatus;
	/** A slice of the single verified read. */
	bytes: Buffer;
}

export type BundleVerdict =
	| {
			ok: true;
			digest: string;
			header: BundleHeader;
			items: ReadonlyMap<string, VerifiedBundleItem>;
	  }
	| {
			ok: false;
			code: BundleFailureCode;
			/** Could not verify right now (I/O pressure, deadline) — never treated as verified. */
			transient: boolean;
	  };

export interface VerifyBundleExpect {
	digest: string;
	result_envelope_hash: string;
	envelope: BundleEnvelope;
	/** The recorded byte length (bundle row), when known. */
	byte_len?: number;
}

export interface VerifyBundleOptions {
	max_bytes?: number;
	deadline_ms?: number;
	now?: () => number;
}

const TRANSIENT_ERRNO = new Set(["EMFILE", "ENFILE", "EIO", "EINTR", "EAGAIN"]);
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Strict verification of one bundle against the request that names it. Never throws. */
export function verifyBundle(
	artifactsRoot: string,
	expect: VerifyBundleExpect,
	o: VerifyBundleOptions = {},
): BundleVerdict {
	const fail = (code: BundleFailureCode, transient = false): BundleVerdict => ({
		ok: false,
		code,
		transient,
	});
	const now = o.now ?? Date.now;
	const deadline = now() + (o.deadline_ms ?? 10_000);
	const max = o.max_bytes ?? DEFAULT_MAX_BUNDLE_BYTES;
	if (!DIGEST.test(expect.digest)) return fail("bundle_missing");

	let root: string;
	try {
		root = realpathSync(artifactsRoot);
	} catch {
		return fail("bundle_missing");
	}
	const dir = join(root, SEALED_DIR);
	try {
		const st = lstatSync(dir);
		if (st.isSymbolicLink() || !st.isDirectory())
			return fail("bundle_not_regular");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? "";
		if (code === "ENOENT") return fail("bundle_missing");
		return fail("bundle_unreadable", TRANSIENT_ERRNO.has(code));
	}

	let fd: number;
	try {
		fd = openSync(join(dir, `${expect.digest}.bundle`), SAFE_READ_FLAGS);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? "";
		if (code === "ENOENT") return fail("bundle_missing");
		if (code === "ELOOP") return fail("bundle_not_regular");
		return fail("bundle_unreadable", TRANSIENT_ERRNO.has(code));
	}
	let buf: Buffer;
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) return fail("bundle_not_regular");
		if (st.size > max) return fail("bundle_oversized");
		if (expect.byte_len !== undefined && st.size !== expect.byte_len)
			return fail("bundle_hash_mismatch");
		buf = Buffer.alloc(st.size);
		let off = 0;
		while (off < buf.length) {
			const n = readSync(fd, buf, off, buf.length - off, off);
			if (n <= 0) break;
			off += n;
		}
		if (off !== buf.length) return fail("bundle_unreadable");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? "";
		return fail("bundle_unreadable", TRANSIENT_ERRNO.has(code));
	} finally {
		closeSync(fd);
	}
	if (now() > deadline) return fail("bundle_unreadable", true);
	if (sha256Hex(buf) !== expect.digest) return fail("bundle_hash_mismatch");

	// header: one canonical JSON line
	const nl = buf.indexOf(0x0a);
	if (nl <= 0 || nl > MAX_BUNDLE_HEADER_BYTES)
		return fail("bundle_header_invalid");
	let header: BundleHeader;
	try {
		const text = FATAL_UTF8.decode(buf.subarray(0, nl));
		const parsed = BundleHeader.safeParse(JSON.parse(text));
		if (!parsed.success || canonicalEncode(parsed.data) !== text)
			return fail("bundle_header_invalid");
		header = parsed.data;
	} catch {
		return fail("bundle_header_invalid");
	}
	const body = buf.subarray(nl + 1);
	let offset = 0;
	for (const it of header.items) {
		if (it.offset !== offset) return fail("bundle_header_invalid");
		offset += it.byte_len;
	}
	if (offset !== body.length) return fail("bundle_header_invalid");

	// binding: this envelope of this attempt, exactly its verified/truncated items, in order
	const env = expect.envelope;
	const expected = bundledArtifacts(env);
	if (
		header.result_envelope_hash !== expect.result_envelope_hash ||
		header.managed_task_id !== env.managed_task_id ||
		header.run_id !== env.run_id ||
		header.items.length !== expected.length
	)
		return fail("bundle_binding_mismatch");
	const items = new Map<string, VerifiedBundleItem>();
	for (const [i, it] of header.items.entries()) {
		const a = expected[i];
		if (
			!a ||
			a.artifact_id !== it.artifact_id ||
			a.name !== it.name ||
			a.sha256 !== it.sha256 ||
			a.byte_len !== it.byte_len
		)
			return fail("bundle_binding_mismatch");
		const bytes = body.subarray(it.offset, it.offset + it.byte_len);
		if (sha256Hex(bytes) !== it.sha256) return fail("bundle_hash_mismatch");
		items.set(it.artifact_id, {
			artifact_id: it.artifact_id,
			name: it.name,
			sha256: it.sha256,
			byte_len: it.byte_len,
			status: a.status,
			bytes,
		});
	}
	return { ok: true, digest: expect.digest, header, items };
}
