// v1.2 §B durable accepted evidence: the bundle file built from the sealer's exact verified buffers,
// published atomically under <artifacts_root>/_sealed, and verified strictly (fixed codes, bounded,
// never following a symlink, never blocking on a FIFO). Real human_ready attempts (existing
// Orchestrator, fake adapters, disposable fixture repo); every tamper is an ordinary file change.
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	EVIDENCE_BUNDLE_CONTRACT,
	type SealedResult,
} from "@agent-city/schema/workspace-m1";
import {
	canonicalEncode,
	sha256Hex,
} from "@agent-city/schema/workspace-m1/hash";
import {
	BundleError,
	buildBundle,
	bundledArtifacts,
	publishBundle,
	publishSealedEvidence,
	SEALED_DIR,
	sealedEvidenceOf,
	verifyBundle,
} from "./bundle.ts";
import {
	cleanupSealFixtures,
	type Harness,
	humanReadyRun,
} from "./seal-fixture.ts";
import { createEvidenceSealer } from "./sealer.ts";

afterAll(cleanupSealFixtures);

async function sealed(h?: Harness): Promise<{ h: Harness; s: SealedResult }> {
	const harness = h ?? (await humanReadyRun());
	const sealer = createEvidenceSealer({
		db: harness.fx.db,
		config: harness.fx.config,
		reads: harness.reads,
	});
	return { h: harness, s: await sealer.seal(harness.input) };
}

const root = (h: Harness) => h.fx.config.artifacts_root;
const bundleFile = (h: Harness, digest: string) =>
	join(root(h), SEALED_DIR, `${digest}.bundle`);
const expectFor = (s: SealedResult, digest: string) => ({
	digest,
	result_envelope_hash: s.envelope_hash,
	envelope: s.envelope,
});
const code = (v: ReturnType<typeof verifyBundle>) => (v.ok ? "ok" : v.code);

/** A file whose digest is right but whose header is the given object (crafted bundles). */
function craft(h: Harness, header: unknown, body: Buffer, raw?: string) {
	const line = raw ?? canonicalEncode(header);
	const bytes = Buffer.concat([Buffer.from(`${line}\n`), body]);
	const digest = sha256Hex(bytes);
	mkdirSync(join(root(h), SEALED_DIR), { recursive: true, mode: 0o700 });
	writeFileSync(bundleFile(h, digest), bytes, { mode: 0o600 });
	return digest;
}

describe("build + publish", () => {
	test("the bundle holds exactly the sealer's verified buffers, content-addressed, 0700/0600", async () => {
		const { h, s } = await sealed();
		const originals = new Map(
			bundledArtifacts(s.envelope).map((a) => [
				a.artifact_id,
				readFileSync(h.path(a.name)),
			]),
		);
		const row = publishSealedEvidence(root(h), s, "2026-10-02T08:00:00.000Z");
		const file = bundleFile(h, row.digest);
		const bytes = readFileSync(file);
		expect(row.rel_path).toBe(`_sealed/${row.digest}.bundle`);
		expect(sha256Hex(bytes)).toBe(row.digest);
		expect(row.byte_len).toBe(bytes.length);
		expect(row.result_envelope_hash).toBe(s.envelope_hash);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(join(root(h), SEALED_DIR)).mode & 0o777).toBe(0o700);
		// header: canonical JSON line; items = the envelope's verified/truncated artifacts, in order
		const nl = bytes.indexOf(0x0a);
		const header = JSON.parse(bytes.subarray(0, nl).toString("utf8"));
		expect(canonicalEncode(header)).toBe(
			bytes.subarray(0, nl).toString("utf8"),
		);
		expect(header.contract).toBe(EVIDENCE_BUNDLE_CONTRACT);
		expect(
			header.items.map((i: { artifact_id: string }) => i.artifact_id),
		).toEqual(bundledArtifacts(s.envelope).map((a) => a.artifact_id));
		expect(row.item_count).toBe(header.items.length);
		expect(header.items.length).toBeGreaterThanOrEqual(4);
		const v = verifyBundle(root(h), expectFor(s, row.digest));
		if (!v.ok) throw new Error(v.code);
		for (const [id, it] of v.items)
			expect(it.bytes.equals(originals.get(id) as Buffer)).toBe(true);
		// no temp file left behind
		expect(
			readdirSync(join(root(h), SEALED_DIR)).filter((n) =>
				n.startsWith(".tmp-"),
			),
		).toEqual([]);
	});

	test("never recaptures changed content: a file changed after sealing does not enter the bundle", async () => {
		const { h, s } = await sealed();
		const original = readFileSync(h.path("diff.patch"));
		h.writeFile("diff.patch", "diff --git a/x b/x\n+CHANGED-AFTER-SEAL\n");
		const row = publishSealedEvidence(root(h), s, "2026-10-02T08:00:00.000Z");
		const v = verifyBundle(root(h), expectFor(s, row.digest));
		if (!v.ok) throw new Error(v.code);
		const diff = [...v.items.values()].find((i) => i.name === "diff.patch");
		expect(diff?.bytes.equals(original)).toBe(true);
		expect(readFileSync(bundleFile(h, row.digest)).toString()).not.toContain(
			"CHANGED-AFTER-SEAL",
		);
	});

	test("idempotent for the same content; an existing target with other bytes is never overwritten", async () => {
		const { h, s } = await sealed();
		const built = buildBundle(s);
		const a = publishBundle(root(h), built);
		const b = publishBundle(root(h), built); // same content address: no-op
		expect(b).toEqual(a);
		writeFileSync(bundleFile(h, built.digest), "something else");
		expect(() => publishBundle(root(h), built)).toThrow(BundleError);
		expect(readFileSync(bundleFile(h, built.digest), "utf8")).toBe(
			"something else",
		);
	});

	test("only the sealer's own result object carries buffers (a copy cannot be bundled)", async () => {
		const { s } = await sealed();
		expect(sealedEvidenceOf(s)).not.toBeNull();
		const copy: SealedResult = { ...s };
		expect(sealedEvidenceOf(copy)).toBeNull();
		expect(() => buildBundle(copy)).toThrow(/no_sealed_buffers/);
	});

	test("publication failure: unwritable or symlinked _sealed, missing root → BundleError, no bundle", async () => {
		const { h, s } = await sealed();
		const dir = join(root(h), SEALED_DIR);
		mkdirSync(dir, { mode: 0o700 });
		chmodSync(dir, 0o500);
		try {
			expect(() =>
				publishSealedEvidence(root(h), s, "2026-10-02T08:00:00.000Z"),
			).toThrow(/write_failed/);
		} finally {
			chmodSync(dir, 0o700);
		}
		expect(readdirSync(dir)).toEqual([]);
		// a symlinked _sealed is never followed
		rmSync(dir, { recursive: true });
		const elsewhere = join(h.fx.dir, "elsewhere");
		mkdirSync(elsewhere);
		symlinkSync(elsewhere, dir);
		expect(() =>
			publishSealedEvidence(root(h), s, "2026-10-02T08:00:00.000Z"),
		).toThrow(/sealed_dir_invalid/);
		expect(readdirSync(elsewhere)).toEqual([]);
		expect(() =>
			publishSealedEvidence(
				join(h.fx.dir, "no-such-root"),
				s,
				"2026-10-02T08:00:00.000Z",
			),
		).toThrow(/root_unavailable/);
	});

	test("partial write: a crash before the rename leaves no bundle; a leftover partial temp is never evidence", async () => {
		const { h, s } = await sealed();
		const built = buildBundle(s);
		let leftover = "";
		expect(() =>
			publishBundle(root(h), built, {
				beforeRename(tmp) {
					leftover = tmp;
					throw new Error("crash");
				},
			}),
		).toThrow(BundleError);
		expect(existsSync(leftover)).toBe(false); // removed on the failure path
		expect(existsSync(bundleFile(h, built.digest))).toBe(false);
		expect(code(verifyBundle(root(h), expectFor(s, built.digest)))).toBe(
			"bundle_missing",
		);
		// a process killed mid-write leaves a truncated temp; it never has the content-address name
		const partial = join(root(h), SEALED_DIR, ".tmp-crashed");
		writeFileSync(partial, built.bytes.subarray(0, 40));
		publishBundle(root(h), built);
		expect(code(verifyBundle(root(h), expectFor(s, built.digest)))).toBe("ok");
		// …and a truncated final file (written around the hub) fails closed
		writeFileSync(
			bundleFile(h, built.digest),
			built.bytes.subarray(0, built.bytes.length - 7),
		);
		expect(code(verifyBundle(root(h), expectFor(s, built.digest)))).toBe(
			"bundle_hash_mismatch",
		);
	});
});

describe("verifyBundle (fixed codes, bounded)", () => {
	test("missing / hash mismatch (flip, append, truncate) / recorded length mismatch / oversized", async () => {
		const { h, s } = await sealed();
		const row = publishSealedEvidence(root(h), s, "2026-10-02T08:00:00.000Z");
		const file = bundleFile(h, row.digest);
		const good = readFileSync(file);
		expect(
			code(
				verifyBundle(root(h), {
					...expectFor(s, row.digest),
					byte_len: row.byte_len,
				}),
			),
		).toBe("ok");
		expect(
			code(
				verifyBundle(root(h), {
					...expectFor(s, row.digest),
					byte_len: row.byte_len + 1,
				}),
			),
		).toBe("bundle_hash_mismatch");
		expect(
			code(verifyBundle(root(h), expectFor(s, row.digest), { max_bytes: 10 })),
		).toBe("bundle_oversized");
		const flipped = Buffer.from(good);
		flipped[flipped.length - 1] = (flipped[flipped.length - 1] as number) ^ 1;
		for (const bad of [
			flipped,
			Buffer.concat([good, Buffer.from("x")]),
			good.subarray(0, 10),
		]) {
			writeFileSync(file, bad);
			expect(code(verifyBundle(root(h), expectFor(s, row.digest)))).toBe(
				"bundle_hash_mismatch",
			);
		}
		rmSync(file);
		expect(code(verifyBundle(root(h), expectFor(s, row.digest)))).toBe(
			"bundle_missing",
		);
		rmSync(join(root(h), SEALED_DIR), { recursive: true });
		expect(code(verifyBundle(root(h), expectFor(s, row.digest)))).toBe(
			"bundle_missing",
		);
	});

	test("symlink / FIFO / directory substitution → bundle_not_regular, promptly (never blocks)", async () => {
		const { h, s } = await sealed();
		const row = publishSealedEvidence(root(h), s, "2026-10-02T08:00:00.000Z");
		const file = bundleFile(h, row.digest);
		const copy = join(h.fx.dir, "valid-copy.bundle");
		copyFileSync(file, copy);
		rmSync(file);
		symlinkSync(copy, file); // the target IS a valid bundle: still refused
		expect(code(verifyBundle(root(h), expectFor(s, row.digest)))).toBe(
			"bundle_not_regular",
		);
		rmSync(file);
		expect(Bun.spawnSync(["/usr/bin/mkfifo", file]).exitCode).toBe(0);
		const t0 = performance.now();
		expect(code(verifyBundle(root(h), expectFor(s, row.digest)))).toBe(
			"bundle_not_regular",
		);
		expect(performance.now() - t0).toBeLessThan(1_000);
		rmSync(file);
		mkdirSync(file);
		expect(code(verifyBundle(root(h), expectFor(s, row.digest)))).toBe(
			"bundle_not_regular",
		);
		rmSync(file, { recursive: true });
		// a symlinked _sealed directory is not followed either
		const dir = join(root(h), SEALED_DIR);
		const moved = join(h.fx.dir, "sealed-moved");
		renameSync(dir, moved);
		copyFileSync(copy, join(moved, `${row.digest}.bundle`));
		symlinkSync(moved, dir);
		expect(code(verifyBundle(root(h), expectFor(s, row.digest)))).toBe(
			"bundle_not_regular",
		);
	});

	test("unreadable (permission) → bundle_unreadable, not transient", async () => {
		const { h, s } = await sealed();
		const row = publishSealedEvidence(root(h), s, "2026-10-02T08:00:00.000Z");
		const file = bundleFile(h, row.digest);
		chmodSync(file, 0o000);
		try {
			const v = verifyBundle(root(h), expectFor(s, row.digest));
			expect(v).toEqual({
				ok: false,
				code: "bundle_unreadable",
				transient: false,
			});
		} finally {
			chmodSync(file, 0o600);
		}
	});

	test("header: non-canonical / bad offsets / garbage → bundle_header_invalid; wrong binding → bundle_binding_mismatch", async () => {
		const { h, s } = await sealed();
		const built = buildBundle(s);
		const nl = built.bytes.indexOf(0x0a);
		const header = JSON.parse(built.bytes.subarray(0, nl).toString("utf8"));
		const body = built.bytes.subarray(nl + 1);
		const v = (digest: string) =>
			code(verifyBundle(root(h), expectFor(s, digest)));
		// same content, pretty-printed header (not canonical)
		expect(
			v(
				craft(
					h,
					header,
					body,
					JSON.stringify(header, null, 1).replace(/\n/g, " "),
				),
			),
		).toBe("bundle_header_invalid");
		// offsets that do not tile the body
		const shifted = structuredClone(header);
		shifted.items[1].offset += 1;
		expect(v(craft(h, shifted, body))).toBe("bundle_header_invalid");
		expect(
			v(craft(h, header, Buffer.concat([body, Buffer.from("extra")]))),
		).toBe("bundle_header_invalid");
		expect(v(craft(h, null, body, "not json at all"))).toBe(
			"bundle_header_invalid",
		);
		expect(v(craft(h, { ...header, extra: 1 }, body))).toBe(
			"bundle_header_invalid",
		);
		// a well-formed bundle of ANOTHER envelope / run / item list
		expect(
			v(craft(h, { ...header, result_envelope_hash: "ab".repeat(32) }, body)),
		).toBe("bundle_binding_mismatch");
		const fewer = structuredClone(header);
		const dropped = fewer.items.pop();
		expect(
			v(craft(h, fewer, body.subarray(0, body.length - dropped.byte_len))),
		).toBe("bundle_binding_mismatch");
		// a slice that does not hash to its item (header claims the envelope's sha256)
		const forged = Buffer.from(body);
		forged[0] = (forged[0] as number) ^ 1;
		expect(v(craft(h, header, forged))).toBe("bundle_hash_mismatch");
		// the genuine bundle verifies
		publishBundle(root(h), built);
		expect(v(built.digest)).toBe("ok");
		expect(v("not-a-digest")).toBe("bundle_missing");
	});
});
