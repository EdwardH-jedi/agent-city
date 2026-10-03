// Display reader (v1.1 ArtifactTextResponse) and the retained verified bytes, against real
// human_ready attempts. Synthetic canaries only.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { ArtifactTextResponse } from "@agent-city/schema/workspace-m1";
import { redactDiff, redactLog } from "../../managed/evidence.ts";
import {
	decideDiffDisclosure,
	disclosureEvidence,
	renderWithPlaceholders,
} from "./disclosure.ts";
import { ArtifactNotFound, readArtifactText } from "./reader.ts";
import { RetainedEvidenceStore } from "./retained.ts";
import {
	cleanupSealFixtures,
	type Harness,
	humanReadyRun,
} from "./seal-fixture.ts";
import { createEvidenceSealer } from "./sealer.ts";

afterAll(cleanupSealFixtures);

const canary = (tag: string) => `CANARY-${tag}-${"Vm2q".repeat(3)}`;

const read = (
	h: Harness,
	name: string,
	o: { retained?: RetainedEvidenceStore; view_max_bytes?: number } = {},
	bound?: NonNullable<Parameters<typeof readArtifactText>[1]["bound"]>,
) =>
	readArtifactText(
		{
			db: h.fx.db,
			config: h.fx.config,
			retained: o.retained,
			view_max_bytes: o.view_max_bytes,
		},
		{ managed_task_id: h.task.id, artifact_id: h.row(name).id, bound },
	);

describe("serving", () => {
	test("clean attempt: every artifact is served verified, diff byte-exact, logs redacted again", async () => {
		const h = await humanReadyRun();
		for (const name of [
			"diff.patch",
			"manifest.json",
			"review-output.json",
			"implementation.log",
			"review.log",
			"verify-1-fixture-check.log",
			"changed-files.json",
		]) {
			const r = await read(h, name);
			expect(ArtifactTextResponse.safeParse(r).success).toBe(true);
			expect([name, r.status, r.withheld_reasons]).toEqual([
				name,
				"verified",
				[],
			]);
			const file = await Bun.file(h.path(name)).text();
			expect(r.text).toBe(name === "diff.patch" ? file : redactLog(file));
		}
	});

	test("unknown artifacts / other tasks are not found", async () => {
		const h = await humanReadyRun();
		const go = (task: string, art: string) =>
			readArtifactText(
				{ db: h.fx.db, config: h.fx.config },
				{ managed_task_id: task, artifact_id: art },
			);
		for (const [t, a] of [
			[h.task.id, "art-00000000-0000-4000-8000-000000000000"],
			["task-00000000-0000-4000-8000-000000000000", h.row("diff.patch").id],
			[h.task.id, "../../etc/passwd"],
		] as const)
			expect(go(t, a)).rejects.toBeInstanceOf(ArtifactNotFound);
	});

	test("display cap truncates on a token boundary and says so", async () => {
		const h = await humanReadyRun();
		const r = await read(h, "diff.patch", { view_max_bytes: 40 });
		expect(r.truncated).toBe(true);
		const shown = r.text ?? "";
		expect(shown.length).toBeLessThanOrEqual(41);
		const file = await Bun.file(h.path("diff.patch")).text();
		expect(file.startsWith(shown.replace(/…$/, ""))).toBe(true);
		expect(
			/[^\s"'=:,;]$/.test(shown.replace(/…$/, "")) && !shown.endsWith("…"),
		).toBe(false);
	});
});

describe("validation/use: sealed bytes are what is served", () => {
	test("after sealing, a replaced file is not served: retained bytes, or refusal on a fresh read", async () => {
		const h = await humanReadyRun();
		const retained = new RetainedEvidenceStore();
		const sealer = createEvidenceSealer({
			db: h.fx.db,
			config: h.fx.config,
			retained,
		});
		const sealed = await sealer.seal(h.input);
		const original = await Bun.file(h.path("diff.patch")).text();
		h.writeFile("diff.patch", original.replace(/\+/g, "-")); // same length, other content
		const bound = {
			envelope: sealed.envelope,
			envelope_hash: sealed.envelope_hash,
		};
		const kept = await read(h, "diff.patch", { retained }, bound);
		expect([kept.status, kept.text]).toEqual(["verified", original]);
		const fresh = await read(
			h,
			"diff.patch",
			{ retained: new RetainedEvidenceStore() },
			bound,
		);
		expect(fresh.status).toBe("corrupt");
		expect(fresh.text).toBeNull();
		expect(fresh.withheld_reasons).toEqual(
			expect.arrayContaining(["differs_from_sealed", "hash_mismatch"]),
		);
	});

	test("coherent file+row replacement after sealing differs from the sealed item → refused", async () => {
		const h = await humanReadyRun();
		const sealer = createEvidenceSealer({ db: h.fx.db, config: h.fx.config });
		const sealed = await sealer.seal(h.input);
		h.rewrite("implementation.log", "replaced log\n");
		const r = await read(
			h,
			"implementation.log",
			{},
			{
				envelope: sealed.envelope,
				envelope_hash: sealed.envelope_hash,
			},
		);
		expect(r.status).toBe("corrupt");
		expect(r.withheld_reasons).toContain("differs_from_sealed");
		expect(r.text).toBeNull();
	});
});

describe("C5 unit binding for every served artifact", () => {
	test("a corrupt manifest-linked log blocks artifacts outside the manifest too", async () => {
		const h = await humanReadyRun();
		const p = h.path("verify-1-fixture-check.log");
		const b = Buffer.from(await Bun.file(p).arrayBuffer());
		b[0] = (b[0] as number) ^ 1;
		writeFileSync(p, b);
		const r = await read(h, "implementation.log");
		expect(r.status).toBe("corrupt");
		expect(r.withheld_reasons).toContain("evidence_unit_not_verified");
		expect(r.text).toBeNull();
	});

	test("a review bound to other evidence makes the unit stale", async () => {
		const h = await humanReadyRun();
		h.sql(
			"UPDATE managed_reviews SET manifest_hash = ? WHERE run_id = ?",
			"9".repeat(64),
			h.run.id,
		);
		const r = await read(h, "review.log");
		expect(r.status).toBe("stale");
		expect(r.withheld_reasons).toContain("review_binding_mismatch");
		expect(r.text).toBeNull();
	});

	test("FIFO in place of an artifact: answered at once, nothing served", async () => {
		const h = await humanReadyRun();
		const fifo = h.path("review.log");
		rmSync(fifo);
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		const t0 = Date.now();
		const r = await read(h, "review.log");
		expect(Date.now() - t0).toBeLessThan(10_000);
		expect([r.status, r.text]).toEqual(["corrupt", null]);
		expect(r.withheld_reasons).toContain("special_file");
	});

	test("omitted-hunk secret stored in the legacy form is withheld with codes only", async () => {
		const body = Array.from(
			{ length: 12 },
			(_, i) => `  line-${i}-${canary(`R${i}`)}`,
		);
		const yaml = (b: string[]) =>
			["name: x", "api_token: |", ...b, "tail: t", ""].join("\n");
		const h = await humanReadyRun({ base: { "config/app.yaml": yaml(body) } });
		const changed = [...body];
		changed[9] = `  line-9-${canary("RNEW")}`;
		await h.recandidate({ "config/app.yaml": yaml(changed) }, (raw) =>
			redactDiff(raw),
		);
		const r = await read(h, "diff.patch");
		expect(r.status).toBe("withheld");
		expect(r.text).toBeNull();
		expect(r.withheld_reasons).toContain("diff_not_disclosure_form");
		expect(JSON.stringify(r)).not.toContain("CANARY");
	});

	test("verified bytes that are not UTF-8 are withheld, not served lossy", async () => {
		const h = await humanReadyRun();
		h.rewrite("review.log", Uint8Array.from([0x61, 0xff, 0x0a]));
		const r = await read(h, "review.log");
		expect([r.status, r.text, r.withheld_reasons]).toEqual([
			"withheld",
			null,
			["undecodable"],
		]);
	});
});

describe("retained store", () => {
	const item = (
		id: string,
		text: string,
		status: "verified" | "corrupt" = "verified",
	) => {
		const buffer = Buffer.from(text);
		return {
			artifact_id: id,
			sha256: new Bun.CryptoHasher("sha256").update(buffer).digest("hex"),
			status,
			buffer,
		};
	};
	const scope = { managed_task_id: "task-1", run_id: "run-1" };

	test("copies in and out, scope-checked, unretainable statuses skipped", () => {
		const s = new RetainedEvidenceStore();
		const a = item("a", "alpha");
		s.put({
			envelope_hash: "h1",
			...scope,
			items: [a, item("b", "beta", "corrupt")],
		});
		a.buffer.fill(0); // caller mutates its buffer after put
		const got = s.take("h1", scope, "a");
		expect(got?.buffer.toString()).toBe("alpha");
		got?.buffer.fill(0); // and mutates the copy it received
		expect(s.take("h1", scope, "a")?.buffer.toString()).toBe("alpha");
		expect(s.take("h1", scope, "b")).toBeNull();
		expect(s.take("h1", { ...scope, run_id: "run-2" }, "a")).toBeNull();
	});

	test("an in-memory change of a retained copy is detected and the entry dropped", () => {
		const s = new RetainedEvidenceStore();
		s.put({ envelope_hash: "h1", ...scope, items: [item("a", "alpha")] });
		const internal = (
			s as unknown as {
				entries: Map<string, { items: Map<string, { buffer: Buffer }> }>;
			}
		).entries;
		internal.get("h1")?.items.get("a")?.buffer.write("A");
		expect(s.take("h1", scope, "a")).toBeNull();
		expect(s.has("h1")).toBe(false);
	});

	test("bounded by entries, bytes and age", () => {
		let t = 0;
		const s = new RetainedEvidenceStore({
			max_entries: 2,
			max_bytes: 10,
			ttl_ms: 100,
			now: () => t,
		});
		s.put({ envelope_hash: "h1", ...scope, items: [item("a", "1234")] });
		s.put({ envelope_hash: "h2", ...scope, items: [item("a", "1234")] });
		s.put({ envelope_hash: "h3", ...scope, items: [item("a", "1234")] });
		expect([s.has("h1"), s.has("h2"), s.has("h3")]).toEqual([
			false,
			true,
			true,
		]);
		s.put({
			envelope_hash: "big",
			...scope,
			items: [item("a", "x".repeat(11))],
		});
		expect(s.has("big")).toBe(false);
		t = 1000;
		expect(s.take("h3", scope, "a")).toBeNull();
	});
});

test("Part A results map onto the frozen evidence status (and R-E3 placeholders)", () => {
	const ok = decideDiffDisclosure({ diff: "", contexts: [] });
	expect(disclosureEvidence(ok)).toEqual({
		status: "verified",
		withheld_reasons: [],
	});
	const diff =
		"diff --git a/x b/x\nindex 1234567..89abcde 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\nold mode 100644\nnew mode 100755\n";
	const r = decideDiffDisclosure({ diff, contexts: [] });
	expect(disclosureEvidence(r)).toEqual({
		status: "withheld",
		withheld_reasons: ["context_missing"],
	});
	expect(renderWithPlaceholders(r)).toBe(
		"# agent-city: file 0 withheld (context_missing)\ndiff --git a/y b/y\nold mode 100644\nnew mode 100755\n",
	);
});

test("a bound envelope that does not hash to its bound hash is refused", async () => {
	const h = await humanReadyRun();
	const retained = new RetainedEvidenceStore();
	const sealed = await createEvidenceSealer({
		db: h.fx.db,
		config: h.fx.config,
		retained,
	}).seal(h.input);
	const rewritten = {
		...sealed.envelope,
		artifacts: sealed.envelope.artifacts.map((a) => ({ ...a })),
		required_checks: ["fixture-check", "extra"],
	};
	const r = await read(
		h,
		"diff.patch",
		{ retained },
		{
			envelope: rewritten,
			envelope_hash: sealed.envelope_hash,
		},
	);
	expect([r.status, r.text, r.withheld_reasons]).toEqual([
		"corrupt",
		null,
		["sealed_envelope_mismatch"],
	]);
});
