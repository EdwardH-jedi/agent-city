// loadConfig() runs at the start of every Claude Code hook (Hard rule 4: all work inside 450 ms) and
// parses this checkout's .env. The old line regex `\s*=\s*(.*?)\s*$` and the comment strip `\s+#.*$`
// re-scanned whitespace runs from every position (64 KB `HUB_URL=a<spaces>x` took 2.1 s; spaces then
// letters then a lone \r was cubic). The parser must stay linear AND keep every result unchanged.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseEnvFile } from "./config.ts";

const N = 64 * 1024;
const KEYS = ["HUB_URL", "INGEST_TOKEN"];

describe(".env parsing is linear", () => {
	test.each([
		["value: a + spaces + x", `HUB_URL=a${" ".repeat(N)}x`],
		["value: a + tabs + x", `HUB_URL=a${"\t".repeat(N)}x`],
		[
			"spaces, letters, lone \\r",
			`HUB_URL=${" ".repeat(N / 2)}${"a".repeat(N / 2)}\rb`,
		],
		["spaces then # far away", `HUB_URL=a${" a".repeat(N / 2)}#`],
		["leading spaces + x", `${" ".repeat(N)}x`],
		["export + spaces + x", `export${" ".repeat(N)}x`],
		["key + spaces + x", `HUB_URL${" ".repeat(N)}x`],
		["many lines of spaces", `HUB_URL=a${" ".repeat(64)}x\n`.repeat(N / 74)],
	] as const)("%s: < 50 ms", (_, text) => {
		parseEnvFile("HUB_URL=warm", KEYS);
		const t = performance.now();
		parseEnvFile(text, KEYS);
		expect(performance.now() - t).toBeLessThan(50);
	});

	test("HUB_URL with a long run of slashes before the end: < 50 ms", () => {
		const dir = mkdtempSync(join(tmpdir(), "agentcity-envbound-"));
		try {
			const envPath = join(dir, ".env");
			writeFileSync(envPath, `HUB_URL=http://h${"/".repeat(N)}x\n`);
			const t = performance.now();
			loadConfig({}, envPath);
			loadConfig({ HUB_URL: `http://h${"/".repeat(N)}x` }, envPath);
			expect(performance.now() - t).toBeLessThan(50);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe(".env parsing: same results as the regex version", () => {
	// the previous implementation, verbatim — the oracle
	function oldParseEnvFile(
		text: string,
		keys: readonly string[],
	): Record<string, string> {
		const out: Record<string, string> = {};
		for (const raw of text.split("\n")) {
			const m =
				/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
			if (!m?.[1] || !keys.includes(m[1])) continue;
			let v = m[2] ?? "";
			const q = v[0];
			if ((q === '"' || q === "'") && v.endsWith(q) && v.length >= 2) {
				v = v.slice(1, -1);
			} else {
				v = v.replace(/\s+#.*$/, "");
			}
			out[m[1]] = v;
		}
		return out;
	}
	const strings = (alphabet: string[], max: number): string[] => {
		let level = [""];
		const all = [""];
		for (let len = 1; len <= max; len++) {
			level = level.flatMap((s) => alphabet.map((c) => s + c));
			all.push(...level);
		}
		return all;
	};
	// CR, U+2028, U+2029 are whitespace to \s but line ends to `.`; NBSP and BOM are \s only
	const TOKENS = [
		"export",
		"K",
		"=",
		" ",
		"\t",
		"\r",
		"#",
		'"',
		"'",
		"a",
		"\u2028",
		"\u00a0",
	];
	const keys = ["K", "export", "a", "exportK"];

	test("every short line over the tricky tokens", () => {
		const tails = strings(TOKENS, 4);
		for (const head of [
			"",
			"K=",
			"K =",
			"export K=",
			" export\tK = ",
			"\ufeffK=",
		])
			for (const t of tails) {
				const line = head + t;
				expect(parseEnvFile(line, keys)).toEqual(oldParseEnvFile(line, keys));
			}
	});

	test("multi-line files (later lines win, \\n splits)", () => {
		for (const t of strings(
			["K=a", "K=b #c", "\n", "\r", " ", "export K='x'"],
			5,
		))
			expect(parseEnvFile(t, keys)).toEqual(oldParseEnvFile(t, keys));
	});

	test("hubUrl keeps stripping only trailing slashes", () => {
		for (const u of [
			"http://h",
			"http://h/",
			"http://h///",
			"http://h/a/",
			"/",
			"///",
			"http://h/ ",
		])
			expect(loadConfig({ HUB_URL: u }, "/nonexistent/.env").hubUrl).toBe(
				u.replace(/\/+$/, ""),
			);
	});
});
