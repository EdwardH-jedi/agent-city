// Web-safety guard: everything reachable from index.ts (the `@agent-city/schema/workspace-m1`
// export that apps/web imports) must be zod + pure TS — no node:/bun: imports, no `Bun` global,
// and never the Bun-only hash entry.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import * as barrel from "./index.ts";

const HERE = import.meta.dir;

function reachable(entry: string): Set<string> {
	const seen = new Set<string>();
	const walk = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		const src = readFileSync(file, "utf8");
		for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
			const spec = m[1] as string;
			if (spec.startsWith(".")) walk(normalize(join(dirname(file), spec)));
			else if (spec !== "zod")
				throw new Error(`${file} imports non-relative module "${spec}"`);
		}
	};
	walk(entry);
	return seen;
}

describe("index.ts is web-safe", () => {
	const files = reachable(join(HERE, "index.ts"));

	test("reaches only zod and relative pure-TS modules", () => {
		expect(files.size).toBeGreaterThan(5);
	});

	test("never reaches hash.ts, canonical.ts, fixtures or tests", () => {
		for (const f of files) {
			expect(f.endsWith("/workspace-m1/hash.ts")).toBe(false);
			expect(f.endsWith("/workspace-m1/canonical.ts")).toBe(false);
			expect(f.includes("/fixtures/")).toBe(false);
			expect(f.endsWith(".test.ts")).toBe(false);
		}
	});

	test("no node:, bun: or Bun reference in any reachable file", () => {
		for (const f of files) {
			const src = readFileSync(f, "utf8");
			expect({ f, node: /["']node:/.test(src) }).toEqual({ f, node: false });
			expect({ f, bun: /["']bun:/.test(src) }).toEqual({ f, bun: false });
			expect({ f, Bun: /\bBun\./.test(src) }).toEqual({ f, Bun: false });
			expect({ f, Buffer: /\bBuffer\b/.test(src) }).toEqual({
				f,
				Buffer: false,
			});
		}
	});

	test("the barrel exposes no hashing / randomness", () => {
		for (const name of [
			"sha256Hex",
			"canonicalEncode",
			"newToken256",
			"newWorkspaceId",
			"challengeHash",
		])
			expect(name in barrel).toBe(false);
	});
});
