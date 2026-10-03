// Static guards over this directory's source (role 07): no browser storage or cookie access (G-3,
// BRW-P-09), no env reads (docs-parity), never the Bun-only hash entry, and no merge/push/deploy
// wording in any visible TSX text (J-17 beyond the screenshotted states).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;

function sources(dir = HERE): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...sources(p));
		else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".test.ts"))
			out.push(p);
	}
	return out;
}

const stripComments = (src: string) =>
	src
		.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const BANNED =
	/\b(merg(e|ed|es|ing)|push(ed|es|ing)?|deploy(ed|s|ing|ment)?)\b/i;

describe("static guards", () => {
	const files = sources();

	test("covers the whole directory", () => {
		expect(files.length).toBeGreaterThan(15);
	});

	test("no browser storage, IndexedDB or document.cookie in the app source", () => {
		// dev/ tools only PROBE storage to prove it stays empty; the app never touches it
		const app = files.filter((f) => !f.includes("/dev/"));
		expect(app.length).toBeGreaterThan(15);
		const hits = app.filter((f) =>
			/\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/.test(
				stripComments(readFileSync(f, "utf8")),
			),
		);
		expect(hits).toEqual([]);
	});

	test("no env reads (import.meta.env / process.env) and no hash entry import", () => {
		const hits = files.filter((f) => {
			const src = readFileSync(f, "utf8");
			return (
				/\b(?:process\.env|import\.meta\.env)\b/.test(src) ||
				/workspace-m1\/hash/.test(src)
			);
		});
		expect(hits).toEqual([]);
	});

	test("no merge/push/deploy wording in visible TSX text", () => {
		const hits = files
			.filter((f) => f.endsWith(".tsx"))
			.flatMap((f) =>
				stripComments(readFileSync(f, "utf8"))
					.split("\n")
					.filter((line) => BANNED.test(line))
					.map((line) => `${f}: ${line.trim()}`),
			);
		expect(hits).toEqual([]);
	});
});
