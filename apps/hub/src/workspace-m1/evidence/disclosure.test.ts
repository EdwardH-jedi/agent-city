// Omitted-hunk disclosure: real `git diff` output from disposable fixture repos, contexts read from
// git objects, synthetic canaries assembled at runtime (nothing here is a real secret).
import { afterAll, describe, expect, test } from "bun:test";
import { redactDiff } from "../../managed/evidence.ts";
import { loadDiffContexts } from "./context-loader.ts";
import { listDiffFiles, parseGitDiff, unquoteGitPath } from "./diff-parse.ts";
import {
	type DisclosureResult,
	decideDiffDisclosure,
	type FileContextEntry,
	gitBlobIds,
} from "./disclosure.ts";
import { cleanupFixtures, type Scenario, scenario } from "./git-fixture.ts";

afterAll(cleanupFixtures);

const canary = (tag: string) => `CANARY-${tag}-${"Qx7w".repeat(3)}`;
const PK = ["PRIVATE", "KEY"].join(" ");
const ghLike = (body: string) => `${"gh"}p_${body}`;
const enc = (s: string) => new TextEncoder().encode(s);

async function decide(
	s: Scenario,
	o: { truncated?: boolean; diff?: string; max_file_bytes?: number } = {},
): Promise<DisclosureResult> {
	const diff = o.diff ?? s.diff;
	const contexts = await loadDiffContexts(
		s.git,
		listDiffFiles(diff, { truncated: o.truncated }),
		{ old_rev: s.base, new_rev: s.head },
		o.max_file_bytes ? { max_file_bytes: o.max_file_bytes } : {},
	);
	return decideDiffDisclosure({ diff, truncated: o.truncated, contexts });
}

function disclosedText(r: DisclosureResult): string {
	if (r.status !== "disclosed")
		throw new Error(
			`expected disclosed, got ${JSON.stringify(r.failures.map((f) => [f.reason, f.detail]))}`,
		);
	return r.text;
}

function expectNoneOf(text: string, needles: readonly string[]) {
	for (const n of needles) expect(text.includes(n)).toBe(false);
}

const numbered = (n: number, f: (i: number) => string) =>
	Array.from({ length: n }, (_, i) => f(i + 1));

// ── the gap and its closure ────────────────────────────────────────────────

describe("omitted-hunk YAML block (header outside the hunk, body inside)", () => {
	const body = numbered(12, (i) => `  body-${i}-${canary(`BLK${i}`)}`);
	const yaml = (b: string[]) =>
		[
			"service: demo",
			"client_secret: |",
			...b,
			"plain_after: visible",
			"",
		].join("\n");
	const changed = [...body];
	changed[9] = `  body-10-${canary("BLKNEW")}`;
	const s = scenario(
		{ "config/app.yaml": yaml(body) },
		{ "config/app.yaml": yaml(changed) },
	);
	const secrets = [...body.map((b) => b.trim()), canary("BLKNEW")];

	test("fixture: the block header really is outside the hunk", () => {
		const hunkBody = s.diff.slice(s.diff.indexOf("\n@@"));
		expect(
			hunkBody.split("\n").some((l) => l.slice(1) === "client_secret: |"),
		).toBe(false);
	});

	test("regression: redactDiff alone leaves the block body visible", () => {
		const out = redactDiff(s.diff);
		expect(secrets.some((c) => out.includes(c))).toBe(true);
	});

	test("decideDiffDisclosure masks every body line using the full old/new versions", async () => {
		const r = await decide(s);
		const text = disclosedText(r);
		expectNoneOf(text, secrets);
		expect(text).toContain("plain_after: visible");
		expect(text).toContain("[REDACTED]");
		if (r.status === "disclosed") expect(r.masked_lines).toBeGreaterThan(0);
	});
});

test("hunk heading (an old line outside the hunk) is masked when it belongs to a secret", async () => {
	const tail = canary("HEAD2");
	const file = (last: string) =>
		[
			"kind: demo",
			'token: "first-part',
			`${tail} continues"`,
			...numbered(10, (i) => `- item ${i === 10 ? last : String(i)}`),
			"",
		].join("\n");
	const s = scenario({ "a.yaml": file("10") }, { "a.yaml": file("ten") });
	const header = s.diff.split("\n").find((l) => l.startsWith("@@")) ?? "";
	expect(header).toContain(tail); // git chose the continuation line as the heading
	expect(redactDiff(s.diff)).toContain(tail); // and line-based redaction keeps it
	const text = disclosedText(await decide(s));
	expect(text).not.toContain(tail);
	expect(text).toMatch(/^@@ -\S+ \+\S+ @@ \[REDACTED\]$/m);
	expect(text).toContain("- item ten");
});

test("unchanged secret field shown as context (name/value pair) is masked", async () => {
	const value = canary("K8S");
	const env = (mode: string) =>
		[
			"env:",
			"  - name: LOG_LEVEL",
			"    value: info",
			"  - name: DB_PASSWORD",
			`    value: ${value}`,
			"  - name: MODE",
			`    value: ${mode}`,
			"",
		].join("\n");
	const s = scenario(
		{ "deploy.yaml": env("fast") },
		{ "deploy.yaml": env("slow") },
	);
	expect(s.diff).toContain(` ${"    value: "}${value}`); // context line
	expect(redactDiff(s.diff)).toContain(value);
	const text = disclosedText(await decide(s));
	expect(text).not.toContain(value);
	expect(text).toContain("+    value: slow");
});

test("multi-line quoted values whose opening line is outside the hunk are masked", async () => {
	const parts = numbered(7, (i) => `  ${canary(`SQ${i}`)}`);
	const file = (after: string) =>
		[
			"password: 'start",
			...parts,
			"  end'",
			`after: ${after}`,
			"other: 2",
			"more: 3",
			"",
		].join("\n");
	const s = scenario({ "q.yaml": file("1") }, { "q.yaml": file("one") });
	const raw = redactDiff(s.diff);
	expect(parts.some((p) => raw.includes(p.trim()))).toBe(true);
	const text = disclosedText(await decide(s));
	expectNoneOf(
		text,
		parts.map((p) => p.trim()),
	);
	expect(text).toContain("+after: one");
});

test("private-key body inside the hunk with BEGIN/END outside it is masked", async () => {
	const lines = numbered(20, (i) => `${canary(`PEM${i}`)}${"AbCd".repeat(4)}`);
	const pem = (b: string[]) =>
		[`-----BEGIN RSA ${PK}-----`, ...b, `-----END RSA ${PK}-----`, ""].join(
			"\n",
		);
	const changed = [...lines];
	changed[9] = `${canary("PEMNEW")}${"EfGh".repeat(4)}`;
	const s = scenario({ "k.pem": pem(lines) }, { "k.pem": pem(changed) });
	expect(lines.some((l) => redactDiff(s.diff).includes(l))).toBe(true);
	const text = disclosedText(await decide(s));
	expectNoneOf(text, [...lines, changed[9] as string]);
});

test("a token split by a backslash continuation is masked although its head is outside the hunk", async () => {
	const head = ghLike("Ab12Cd34");
	const rest = "Ef56Gh78Ij90Kl12Mn34Op56";
	const file = (x: string) =>
		[
			"#!/bin/sh",
			`export SOME_VALUE=${head}\\`,
			`  ${rest}`,
			"echo one",
			"echo two",
			`echo ${x}`,
			"",
		].join("\n");
	const s = scenario({ "run.sh": file("three") }, { "run.sh": file("3") });
	const content = s.diff
		.split("\n")
		.filter((l) => /^[ +-](?![-+]{2} )/.test(l));
	expect(content.some((l) => l.includes(head))).toBe(false); // head line not in the hunk
	expect(redactDiff(s.diff)).toContain(rest);
	const text = disclosedText(await decide(s));
	expect(text).not.toContain(rest);
	expect(text).not.toContain(head); // git also used the head line as the hunk heading
	expect(text).toContain("+echo 3");
});

test("context the NEW version makes secret (key renamed far above, separate hunk) is masked", async () => {
	const body = numbered(14, (i) => `  ${canary(`NEWSIDE${i}`)}`);
	const doc = (key: string, last: string) =>
		[`${key}: |`, ...body, `last: ${last}`, ""].join("\n");
	const s = scenario(
		{ "n.yaml": doc("notes", "1") },
		{ "n.yaml": doc("client_secret", "2") },
	);
	expect(s.diff.match(/^@@/gm)?.length).toBe(2); // the body tail sits in its own hunk
	const text = disclosedText(await decide(s));
	expectNoneOf(
		text,
		body.map((b) => b.trim()),
	);
	expect(text).toContain("+last: 2");
});

test("secret in a deleted file is masked (old side read, new side absent)", async () => {
	const c = canary("DEL");
	const s = scenario(
		{
			"config/creds.yaml": `name: x\nsecret_value: |\n  ${c}\n  second\n`,
			"keep.txt": "k\n",
		},
		{ "config/creds.yaml": null },
	);
	expect(s.diff).toContain("deleted file mode");
	const text = disclosedText(await decide(s));
	expect(text).not.toContain(c);
	expect(text).toContain("-name: x");
});

test("renamed file: old version from the old path, new version from the new path", async () => {
	const body = numbered(12, (i) => `  ${canary(`REN${i}`)}`);
	const doc = (b: string[]) =>
		["title: t", "private_key: |", ...b, "tail: end", ""].join("\n");
	const changed = [...body];
	changed[10] = `  ${canary("RENNEW")}`;
	const s = scenario(
		{ "conf/a.yaml": doc(body) },
		{ "conf/a.yaml": null, "conf/b.yaml": doc(changed) },
	);
	expect(s.diff).toContain("rename from conf/a.yaml");
	expect(s.diff).toContain("rename to conf/b.yaml");
	const refs = listDiffFiles(s.diff);
	expect(refs).toEqual([
		{
			index: 0,
			old_path: "conf/a.yaml",
			new_path: "conf/b.yaml",
			needs_context: true,
		},
	]);
	const text = disclosedText(await decide(s));
	expectNoneOf(text, [...body.map((b) => b.trim()), canary("RENNEW")]);
	expect(text).toContain("rename to conf/b.yaml");
});

// ── clean control ──────────────────────────────────────────────────────────

test("clean control: CRLF, BOM, unicode, odd names, no final newline, mode/rename-only — byte-identical", async () => {
	const weird = 'unié\tq"t.txt';
	const s = scenario(
		{
			"crlf.txt": "alpha\r\nbeta\r\ngamma\r\n",
			"bom.txt": "﻿first\nsecond\n",
			"sp ace.txt": "x\n",
			[weird]: "y\n",
			"no-eol.txt": "one\ntwo",
			"mode.sh": "echo hi\n",
			"moved/old-name.txt": "same content\nline two\nline three\n",
			"app.yaml": "name: demo\nport: 8080\nlabels:\n  - a\n  - b\n",
		},
		{
			"crlf.txt": "alpha\r\nBETA\r\ngamma\r\n",
			"bom.txt": "﻿first\nsecond changed\n",
			"sp ace.txt": "x2\n",
			[weird]: "y2\n",
			"no-eol.txt": "one\ntwo changed",
			"mode.sh": { text: "echo hi\n", mode: 0o755 },
			"moved/old-name.txt": null,
			"moved/new-name.txt": "same content\nline two\nline three\n",
			"app.yaml": "name: demo\nport: 9090\nlabels:\n  - a\n  - b\n",
		},
	);
	expect(s.diff).toContain("\r\n");
	expect(s.diff).toContain("\\ No newline at end of file");
	expect(s.diff).toContain('"a/uni\\303\\251\\tq\\"t.txt"');
	expect(s.diff).toContain("+++ b/sp ace.txt\t");
	expect(s.diff).toContain("similarity index 100%");
	expect(s.diff).toContain("new mode 100755");
	const r = await decide(s);
	expect(disclosedText(r)).toBe(s.diff);
	if (r.status === "disclosed") {
		expect(r.masked_lines).toBe(0);
		expect(
			r.files.map((f) => (f.status === "disclosed" ? f.text : "")).join(""),
		).toBe(s.diff);
	}
});

test("empty diff is disclosed as empty", () => {
	expect(decideDiffDisclosure({ diff: "", contexts: [] })).toEqual({
		status: "disclosed",
		text: "",
		files: [],
		masked_lines: 0,
	});
});

// ── fail closed ───────────────────────────────────────────────────────────

function failuresOf(r: DisclosureResult) {
	if (r.status !== "withheld") throw new Error("expected withheld");
	return r.failures.map((f) => ({
		reason: f.reason,
		side: f.side,
		detail: f.detail,
	}));
}

describe("withholding", () => {
	const c = canary("WH");
	const mk = () =>
		scenario(
			{ "s.yaml": `api_token: |\n  ${c}\n  more\nx: 1\n` },
			{ "s.yaml": `api_token: |\n  ${c}\n  more\nx: 2\n` },
		);

	test("oversized context (loader refuses before reading) → withheld", async () => {
		const s = mk();
		const r = await decide(s, { max_file_bytes: 8 });
		expect(failuresOf(r)).toEqual([
			{ reason: "context_unavailable", side: "old", detail: "oversized" },
			{ reason: "context_unavailable", side: "new", detail: "oversized" },
		]);
		expect(JSON.stringify(r)).not.toContain(c);
	});

	test("oversized context (core limit) → withheld with sizes only", async () => {
		const s = mk();
		const contexts = await loadDiffContexts(s.git, listDiffFiles(s.diff), {
			old_rev: s.base,
			new_rev: s.head,
		});
		const r = decideDiffDisclosure({
			diff: s.diff,
			contexts,
			limits: { max_file_bytes: 10 },
		});
		expect(failuresOf(r).map((f) => f.reason)).toEqual([
			"context_oversized",
			"context_oversized",
		]);
		if (r.status === "withheld") expect(r.failures[0]?.limit).toBe(10);
		expect(JSON.stringify(r)).not.toContain(c);
	});

	test("total context budget exceeded → withheld", async () => {
		const s = mk();
		const contexts = await loadDiffContexts(s.git, listDiffFiles(s.diff), {
			old_rev: s.base,
			new_rev: s.head,
		});
		const r = decideDiffDisclosure({
			diff: s.diff,
			contexts,
			limits: { max_total_context_bytes: 40 },
		});
		expect(failuresOf(r).map((f) => f.reason)).toContain(
			"context_budget_exceeded",
		);
	});

	test("missing / unavailable context → withheld", () => {
		const s = mk();
		expect(
			failuresOf(decideDiffDisclosure({ diff: s.diff, contexts: [] })),
		).toEqual([{ reason: "context_missing", side: null, detail: null }]);
		const r = decideDiffDisclosure({
			diff: s.diff,
			contexts: [
				{
					old_path: "s.yaml",
					new_path: "s.yaml",
					old: { kind: "unavailable", reason: "unreadable" },
					new: { kind: "absent" },
				},
			],
		});
		expect(failuresOf(r)).toEqual([
			{ reason: "context_unavailable", side: "old", detail: "unreadable" },
			{ reason: "context_missing", side: "new", detail: null },
		]);
	});

	test("duplicate context entries → withheld as ambiguous", async () => {
		const s = mk();
		const contexts = await loadDiffContexts(s.git, listDiffFiles(s.diff), {
			old_rev: s.base,
			new_rev: s.head,
		});
		const r = decideDiffDisclosure({
			diff: s.diff,
			contexts: [...contexts, ...contexts],
		});
		expect(failuresOf(r).map((f) => f.reason)).toEqual(["context_ambiguous"]);
	});

	test("context that is not the diffed version → withheld (index + line binding)", async () => {
		const s = mk();
		const contexts = await loadDiffContexts(s.git, listDiffFiles(s.diff), {
			old_rev: s.base,
			new_rev: s.head,
		});
		const entry = contexts[0] as FileContextEntry;
		// an old version WITHOUT the secret header: if accepted, the body would not be masked
		const forged: FileContextEntry = {
			...entry,
			old: { kind: "bytes", bytes: enc(`plain: |\n  ${c}\n  more\nx: 1\n`) },
		};
		const r = decideDiffDisclosure({ diff: s.diff, contexts: [forged] });
		expect(failuresOf(r)).toEqual([
			{ reason: "context_mismatch", side: "old", detail: null },
		]);
		expect(JSON.stringify(r)).not.toContain(c);
	});

	test("forged index line matching forged bytes still fails the line binding", async () => {
		const s = mk();
		const forgedOld = enc(`api_token: |\n  OTHER\n  more\nx: 1\n`);
		const id = gitBlobIds(forgedOld).sha1.slice(0, 7);
		const diff = s.diff.replace(/^index ([0-9a-f]+)\.\./m, `index ${id}..`);
		const contexts = await loadDiffContexts(s.git, listDiffFiles(diff), {
			old_rev: s.base,
			new_rev: s.head,
		});
		const entry = contexts[0] as FileContextEntry;
		const r = decideDiffDisclosure({
			diff,
			contexts: [{ ...entry, old: { kind: "bytes", bytes: forgedOld } }],
		});
		expect(failuresOf(r)).toEqual([
			{ reason: "context_mismatch", side: "old", detail: null },
		]);
	});

	test("diff without an index line → withheld", async () => {
		const s = mk();
		const diff = s.diff.replace(/^index .*\n/m, "");
		const r = await decide(s, { diff });
		expect(failuresOf(r)).toEqual([
			{ reason: "index_missing", side: null, detail: null },
		]);
	});

	test("binary file → withheld", async () => {
		const s = scenario(
			{ "b.bin": Uint8Array.from([0, 1, 2, 3, 65]) },
			{ "b.bin": Uint8Array.from([0, 1, 2, 4, 66]) },
		);
		expect(s.diff).toContain("Binary files");
		expect(failuresOf(await decide(s))).toEqual([
			{ reason: "binary", side: null, detail: null },
		]);
	});

	test("NUL / non-UTF-8 bytes supplied as context → withheld", () => {
		const s = mk();
		const base = {
			old_path: "s.yaml",
			new_path: "s.yaml",
			new: { kind: "absent" } as const,
		};
		const nul = decideDiffDisclosure({
			diff: s.diff,
			contexts: [
				{
					...base,
					old: { kind: "bytes", bytes: Uint8Array.from([97, 0, 98]) },
				},
			],
		});
		expect(failuresOf(nul)[0]?.reason).toBe("context_binary");
		const latin1 = decideDiffDisclosure({
			diff: s.diff,
			contexts: [
				{ ...base, old: { kind: "bytes", bytes: Uint8Array.from([0xe9, 10]) } },
			],
		});
		expect(failuresOf(latin1)[0]?.reason).toBe("context_undecodable");
	});

	test("symlink with content lines → withheld as special file", async () => {
		const s = scenario(
			{ link: { symlink: "target-a" } },
			{ link: { symlink: "target-b" } },
		);
		expect(s.diff).toContain("120000");
		expect(failuresOf(await decide(s))).toEqual([
			{ reason: "special_file", side: null, detail: null },
		]);
	});

	test("YAML-ish secret structure that cannot be delimited → withheld, no content in metadata", async () => {
		const u = canary("UNTERM");
		const file = (x: string) =>
			[
				`password: "never closed ${u}`,
				"  more",
				"a: 1",
				"b: 2",
				"c: 3",
				`d: ${x}`,
				"",
			].join("\n");
		const s = scenario({ "u.yaml": file("1") }, { "u.yaml": file("2") });
		const r = await decide(s);
		expect(failuresOf(r)).toEqual([
			{
				reason: "context_uninterpretable",
				side: "old",
				detail: "unterminated_quote",
			},
			{
				reason: "context_uninterpretable",
				side: "new",
				detail: "unterminated_quote",
			},
		]);
		expect(JSON.stringify(r)).not.toContain(u);
		expect(JSON.stringify(r)).not.toContain("never closed");
	});

	test("truncated diff → its last file is withheld; earlier files still decided", async () => {
		const s = scenario(
			{ "a.txt": "a\n", "b.txt": "b\n" },
			{ "a.txt": "a2\n", "b.txt": "b2\n" },
		);
		const cut = s.diff.slice(0, s.diff.lastIndexOf("+b2"));
		const r = await decide(s, { diff: cut, truncated: true });
		expect(failuresOf(r)).toEqual([
			{ reason: "diff_truncated", side: null, detail: null },
		]);
		if (r.status === "withheld") {
			expect(r.files[0]?.status).toBe("disclosed");
			expect(r.files[1]?.status).toBe("withheld");
		}
		// the same cut without the flag: hunk counts cannot be satisfied
		expect(
			failuresOf(await decide(s, { diff: cut })).map((f) => f.reason),
		).toEqual(["unparseable_diff"]);
	});

	test("combined diffs, preamble text and unknown headers are not parsed — withheld", () => {
		const cc =
			"diff --cc a.txt\nindex 1,2..3\n@@@ -1,1 -1,1 +1,1 @@@\n- a\n +b\n";
		expect(
			failuresOf(decideDiffDisclosure({ diff: cc, contexts: [] })),
		).toEqual([{ reason: "unparseable_diff", side: null, detail: null }]);
		const odd =
			"diff --git a/x b/x\nweird header\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
		expect(
			failuresOf(decideDiffDisclosure({ diff: odd, contexts: [] })),
		).toEqual([{ reason: "unparseable_diff", side: null, detail: null }]);
	});

	test("diff over the byte limit / too many files → withheld before parsing", () => {
		const one = "diff --git a/x b/x\nold mode 100644\nnew mode 100755\n";
		expect(
			failuresOf(
				decideDiffDisclosure({
					diff: one,
					contexts: [],
					limits: { max_diff_bytes: 10 },
				}),
			),
		).toEqual([{ reason: "diff_oversized", side: null, detail: null }]);
		expect(
			failuresOf(
				decideDiffDisclosure({
					diff: one.repeat(3),
					contexts: [],
					limits: { max_files: 2 },
				}),
			),
		).toEqual([{ reason: "too_many_files", side: null, detail: null }]);
	});
});

// ── names ─────────────────────────────────────────────────────────────────

test("unsafe filenames: quoted/newline/token-like names parse, never leak into metadata", async () => {
	const tokenName = `${ghLike("A1b2C3d4E5f6G7h8I9j0K1l2")}.txt`;
	const nl = "line\nbreak.txt";
	const s = scenario(
		{ [tokenName]: Uint8Array.from([0, 1]), [nl]: "a\n" },
		{ [tokenName]: Uint8Array.from([0, 2]), [nl]: "b\n" },
	);
	const r = await decide(s);
	const json = JSON.stringify(r);
	expect(json).not.toContain(tokenName);
	expect(json).not.toContain(tokenName.slice(4, 20));
	if (r.status !== "withheld") throw new Error("expected withheld");
	const byIdx = r.files.map((f) => [f.status, f.path, f.path_id?.length]);
	expect(byIdx).toContainEqual(["withheld", null, 16]);
	const shown = r.files.find((f) => f.status === "disclosed");
	expect(
		shown?.status === "disclosed" &&
			shown.text.includes('"a/line\\nbreak.txt"'),
	).toBe(true);
	const tokenFile = r.files.find((f) => f.status === "withheld");
	expect(
		tokenFile?.status === "withheld" && tokenFile.failures[0]?.reason,
	).toBe("binary");
});

test("header lines naming a token-like file are redacted when disclosed", async () => {
	const tokenName = `${ghLike("Z9y8X7w6V5u4T3s2R1q0P9o8")}.md`;
	const s = scenario({ [tokenName]: "a\n" }, { [tokenName]: "b\n" });
	const text = disclosedText(await decide(s));
	expect(text).not.toContain(tokenName);
	expect(text).toContain("-a\n+b");
});

test("unquoteGitPath decodes git C-style quoting with octal UTF-8 bytes", () => {
	expect(unquoteGitPath('"a/uni\\303\\251\\tq\\"t.txt"')).toEqual({
		value: 'a/unié\tq"t.txt',
		end: 25,
	});
	expect(unquoteGitPath('"bad\\q"')).toBeNull();
	expect(unquoteGitPath('"unterminated')).toBeNull();
	expect(unquoteGitPath('"\\377"')).toBeNull(); // not UTF-8
});

test("parse: hunk counts and EOL markers are tracked exactly", () => {
	const d = parseGitDiff(
		"diff --git a/x b/x\nindex 1234567..89abcde 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@ head\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n",
	);
	const f = d.files[0];
	expect(f?.problem).toBeNull();
	expect(f?.hunks[0]?.heading).toBe("head");
	expect(f?.hunks[0]?.no_eol_old).toBe(2);
	expect(f?.hunks[0]?.no_eol_new).toBe(2);
});

test("parse: copies, dissimilarity rewrites, GIT binary patch, foreign prefixes", () => {
	const hunk = "--- a/x\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n";
	const copy = parseGitDiff(
		`diff --git a/x b/y\nsimilarity index 90%\ncopy from x\ncopy to y\nindex 1234567..89abcde 100644\n${hunk}`,
	).files[0];
	expect([copy?.change, copy?.old_path, copy?.new_path, copy?.problem]).toEqual(
		["copied", "x", "y", null],
	);
	const rewrite = parseGitDiff(
		"diff --git a/x b/x\ndissimilarity index 60%\nindex 1234567..89abcde 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
	).files[0];
	expect(rewrite?.problem).toBeNull();
	const gbp = parseGitDiff(
		"diff --git a/b.bin b/b.bin\nindex 1234567..89abcde 100644\nGIT binary patch\nliteral 5\nMcmZQzWMXCj0004Nd\n\nliteral 0\nHcmV?d00001\n\n",
	).files[0];
	expect(gbp?.problem).toBe("binary");
	const noprefix = parseGitDiff(
		"diff --git x x\nindex 1234567..89abcde 100644\n--- x\n+++ x\n@@ -1 +1 @@\n-a\n+b\n",
	).files[0];
	expect(noprefix?.problem).toBe("unparseable_diff");
});

test("decisions are deterministic", async () => {
	const s = scenario(
		{ "d.yaml": `secret: |\n  ${canary("DET")}\n  x\ny: 1\n`, "e.txt": "e\n" },
		{ "d.yaml": `secret: |\n  ${canary("DET")}\n  x\ny: 2\n`, "e.txt": "e2\n" },
	);
	const a = JSON.stringify(await decide(s));
	const b = JSON.stringify(await decide(s));
	expect(a).toBe(b);
	expect(a).not.toContain(canary("DET"));
});
