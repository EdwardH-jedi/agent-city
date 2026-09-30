import { describe, expect, test } from "bun:test";
import {
	REDACTED,
	redact,
	redactObject,
	summarizeToolInput,
} from "./redact.ts";

// Fake secrets are assembled at runtime so scripts/check-secrets.ts doesn't flag this file.
const fake = {
	ghp: `ghp_${"a".repeat(36)}`,
	gho: `gho_${"b".repeat(36)}`,
	ghs: `ghs_${"c".repeat(36)}`,
	pat: `github_pat_${"d".repeat(22)}_${"e".repeat(59)}`,
	sk: `sk-${"f".repeat(40)}`,
	skAnt: `sk-ant-api03-${"g".repeat(40)}`,
	aws: `AKIA${"H".repeat(16)}`,
	awsSts: `ASIA${"J".repeat(16)}`,
	ghu: `ghu_${"k".repeat(36)}`,
	ghr: `ghr_${"l".repeat(36)}`,
	slack: `xoxb-${"1".repeat(12)}-${"m".repeat(24)}`,
	google: `AIza${"n".repeat(35)}`,
	jwt: `eyJ${"o".repeat(16)}.eyJ${"p".repeat(24)}.${"q".repeat(32)}`,
	bearer: "i".repeat(40),
};

// Plain marker values: anything containing "SEKRIT" must never survive redaction.
const S = (n: number) => `SEKRIT${n}x`;
const expectClean = (out: string) => expect(out).not.toMatch(/SEKRIT/);

// ── Codex review regressions ───────────────────────────────────────────────

describe("regression 1 — command-string masking", () => {
	test.each([
		[
			"JSON double quotes",
			`curl -d '{"token":"${S(1)}"}'`,
			`"token":"${REDACTED}"`,
		],
		[
			"JSON spaced",
			`{"api_key": "${S(2)}", "n": 1}`,
			`"api_key": "${REDACTED}"`,
		],
		["YAML", `token: ${S(3)}`, `token: ${REDACTED}`],
		["python dict", `{'password': '${S(4)}'}`, `'password': '${REDACTED}'`],
		["--token v", `gh --token ${S(5)} repo list`, `--token ${REDACTED} repo`],
		[
			"--password v",
			`mysql --password ${S(6)} db`,
			`--password ${REDACTED} db`,
		],
		["--api-key=v", `tool --api-key=${S(7)} run`, `--api-key=${REDACTED} run`],
		["--api-key v", `tool --api-key ${S(8)} run`, `--api-key ${REDACTED} run`],
	])("%s", (_name, input, expected) => {
		const out = redact(input);
		expectClean(out);
		expect(out).toContain(expected);
	});

	test("single-dash -p is NOT treated as a secret (false-positive guard)", () => {
		expect(redact("mkdir -p src/app")).toBe("mkdir -p src/app");
		expect(redact("docker run -p 8080:80 img")).toBe(
			"docker run -p 8080:80 img",
		);
	});

	test("secret flag followed by another flag masks nothing", () => {
		expect(redact("cmd --token --verbose")).toBe("cmd --token --verbose");
	});

	test.each([
		["Bearer", `Authorization: Bearer ${S(10)}`],
		["Basic", `Authorization: Basic ${S(11)}`],
		["Token", `Authorization: Token ${S(12)}`],
		["Digest", `Authorization: Digest username="u", response="${S(13)}"`],
		["Basic", `curl -H "Authorization: Basic ${S(14)}" https://x`],
		["Token", `{"Authorization":"Token ${S(15)}"}`],
		["basic", `authorization: basic ${S(16)}`],
	])(
		"Authorization %s → credential masked, scheme kept (%s)",
		(scheme, input) => {
			const out = redact(input);
			expectClean(out);
			expect(out).toContain(`${scheme} ${REDACTED}`);
		},
	);

	test.each([
		["api_key: Token", `api_key: Token ${S(50)}`],
		["password: Digest", `password: Digest ${S(51)}`],
		["--api-key Token", `cmd --api-key Token ${S(52)} run`],
		["JSON secret: Bearer", `{"client_secret":"Bearer ${S(53)}"}`],
	])(
		"scheme word under any secret name doesn't shield the credential: %s",
		(_n, input) => {
			const out = redact(input);
			expectClean(out);
			expect(redact(out)).toBe(out);
		},
	);

	test("Authorization Basic keeps the rest of the command", () => {
		expect(redact(`curl -H 'Authorization: Basic ${S(17)}' https://x`)).toBe(
			`curl -H 'Authorization: Basic ${REDACTED}' https://x`,
		);
	});

	test.each([
		`git clone https://me:${S(20)}@github.com/o/r.git`,
		`postgres://admin:${S(21)}@db.local:5432/app`,
		`see HTTPS://user:${S(22)}@example.com/x`,
	])("URL userinfo password masked: %s", (input) => {
		const out = redact(input);
		expectClean(out);
		expect(out).toContain(`:${REDACTED}@`);
	});

	test("URL without password is untouched", () => {
		const s = "https://github.com/o/r.git git@github.com:o/r.git";
		expect(redact(s)).toBe(s);
	});
});

describe("regression 2 — redactObject key rule", () => {
	test("normalized substring match masks whole value (objects included)", () => {
		const out = redactObject({
			"X-Api-Key": S(30),
			Cookie: S(31),
			sessionKey: S(32),
			credentials: { user: "u", pass: S(33) },
			PRIVATE_KEY: S(34),
			accessKeyId: S(35),
			oauth: [S(36)],
			pwd: S(37),
			nested: [{ deeper: { client_secret: S(38) } }],
		});
		expectClean(JSON.stringify(out));
		expect(out.credentials).toBe(REDACTED as unknown as typeof out.credentials);
		expect(out.oauth).toBe(REDACTED as unknown as typeof out.oauth);
	});

	test("allowlist: max_tokens / author / authors / tokenizer kept", () => {
		const input = {
			max_tokens: 100,
			author: "someone",
			authors: ["a", "b"],
			tokenizer: "cl100k",
		};
		expect(redactObject(input)).toEqual(input);
	});

	test("same name rule applies to strings (max_tokens / author kept, tokens masked)", () => {
		expect(redact("max_tokens: 100")).toBe("max_tokens: 100");
		expect(redact("git commit --author=someone")).toBe(
			"git commit --author=someone",
		);
		expectClean(redact(`sessionKey=${S(40)} accessKey: ${S(41)}`));
	});
});

describe("regression 3 — token patterns", () => {
	test.each([
		["ghu_", () => fake.ghu],
		["ghr_", () => fake.ghr],
		["slack xoxb-", () => fake.slack],
		["google AIza", () => fake.google],
		["JWT", () => fake.jwt],
		["AWS ASIA", () => fake.awsSts],
	])("%s is masked in free text", (_name, get) => {
		const secret = get();
		const out = redact(`value is ${secret} ok`);
		expect(out).toBe(`value is ${REDACTED} ok`);
	});

	test("unterminated PEM block is masked to the end", () => {
		const head = `${"-".repeat(5)}BEGIN ${["PRIVATE", "KEY"].join(" ")}${"-".repeat(5)}`;
		// F03: no END marker → everything after BEGIN is hidden
		expect(redact(`${head}\nMIIabc`)).toBe(REDACTED);
	});
});

describe("redact — token patterns", () => {
	test.each([
		["ghp_", fake.ghp],
		["gho_", fake.gho],
		["ghs_", fake.ghs],
		["github_pat_", fake.pat],
		["sk-", fake.sk],
		["sk-ant-", fake.skAnt],
		["AWS access key", fake.aws],
	])("%s is masked", (_name, secret) => {
		const out = redact(`curl -H x ${secret} end`);
		expect(out).not.toContain(secret);
		expect(out).toContain(REDACTED);
		expect(out.endsWith(" end")).toBe(true);
	});

	test("Bearer keeps the scheme", () => {
		expect(redact(`Bearer ${fake.bearer}`)).toBe(`Bearer ${REDACTED}`);
		expect(redact(`authorization: bearer ${fake.bearer}`)).not.toContain(
			fake.bearer,
		);
	});

	test("private key block", () => {
		const dashes = "-".repeat(5);
		const label = ["RSA", "PRIVATE", "KEY"].join(" ");
		const pem = `${dashes}BEGIN ${label}${dashes}\n${"x".repeat(64)}\n${dashes}END ${label}${dashes}`;
		expect(redact(pem)).toBe(REDACTED);
	});
});

describe("redact — KEY=value", () => {
	test.each([
		["GITHUB_TOKEN=abc123", `GITHUB_TOKEN=${REDACTED}`],
		["export INGEST_TOKEN=abc123", `export INGEST_TOKEN=${REDACTED}`],
		['API_KEY="quoted value"', `API_KEY="${REDACTED}"`],
		["DB_PASSWORD='x y'", `DB_PASSWORD='${REDACTED}'`],
		[
			"AWS_SECRET_ACCESS_KEY=zzz bun run",
			`AWS_SECRET_ACCESS_KEY=${REDACTED} bun run`,
		],
		["client_secret: hunter2", `client_secret: ${REDACTED}`],
		[
			"FOO_TOKEN=a && BAR_SECRET=b",
			`FOO_TOKEN=${REDACTED} && BAR_SECRET=${REDACTED}`,
		],
	])("%s", (input, expected) => {
		expect(redact(input)).toBe(expected);
	});

	test("non-secret assignments are untouched", () => {
		const s = "NODE_ENV=production HUB_PORT=4317 bun run dev";
		expect(redact(s)).toBe(s);
	});

	test("empty value (e.g. .env.example) is left alone", () => {
		expect(redact("GITHUB_TOKEN=")).toBe("GITHUB_TOKEN=");
	});
});

describe("redact — safety", () => {
	test("clean paths and commands pass through unchanged", () => {
		for (const s of [
			"/Users/example/code/app/src/index.ts",
			"git status && bun test",
			"src/token.ts",
		]) {
			expect(redact(s)).toBe(s);
		}
	});

	test("idempotent", () => {
		const s = `GITHUB_TOKEN=${fake.ghp} Bearer ${fake.bearer} ${fake.sk} curl -H 'Authorization: Basic ${S(1)}' https://u:${S(2)}@h {"token":"${S(3)}"} --api-key ${S(4)} ${fake.jwt}`;
		const once = redact(s);
		expect(redact(once)).toBe(once);
	});
});

describe("redactObject", () => {
	test("drops secret-named keys and redacts nested strings", () => {
		const out = redactObject({
			headers: { Authorization: `Bearer ${fake.bearer}`, Accept: "json" },
			nested: [{ note: `use ${fake.ghp}` }],
			apiKey: "plain",
			refresh_token: "plain",
			count: 3,
			ok: true,
			nothing: null,
		});
		expect(out).toEqual({
			headers: { Authorization: REDACTED, Accept: "json" },
			nested: [{ note: `use ${REDACTED}` }],
			apiKey: REDACTED,
			refresh_token: REDACTED,
			count: 3,
			ok: true,
			nothing: null,
		});
	});
});

describe("summarizeToolInput", () => {
	test("keeps only tool + file_path for Write (content dropped)", () => {
		expect(
			summarizeToolInput("Write", {
				file_path: "/tmp/example/a.ts",
				content: `const k = "${fake.ghp}"`,
			}),
		).toEqual({ tool: "Write", file_path: "/tmp/example/a.ts" });
	});

	test("Edit: old_string/new_string dropped", () => {
		expect(
			summarizeToolInput("Edit", {
				file_path: "/tmp/example/a.ts",
				old_string: "a",
				new_string: "b",
			}),
		).toEqual({ tool: "Edit", file_path: "/tmp/example/a.ts" });
	});

	test("Bash: command truncated to 80 chars and redacted", () => {
		const cmd = `GITHUB_TOKEN=${fake.ghp} ${"x".repeat(200)}`;
		const s = summarizeToolInput("Bash", { command: cmd, description: "d" });
		expect(s.tool).toBe("Bash");
		expect(s.command?.length).toBeLessThanOrEqual(80);
		expect(s.command).not.toContain("ghp_");
		expect(s.command?.startsWith(`GITHUB_TOKEN=${REDACTED}`)).toBe(true);
		expect(s).not.toHaveProperty("description");
	});

	test("secret straddling the 80-char cut leaks no prefix", () => {
		const cmd = `${"y".repeat(70)} ${fake.ghp}`;
		const s = summarizeToolInput("Bash", { command: cmd });
		expect(s.command).not.toContain("ghp_");
		expect(s.command).not.toContain("aaaa");
	});

	test("Grep path / NotebookEdit notebook_path", () => {
		expect(summarizeToolInput("Grep", { pattern: "p", path: "/x" })).toEqual({
			tool: "Grep",
			file_path: "/x",
		});
		expect(
			summarizeToolInput("NotebookEdit", { notebook_path: "/n.ipynb" }),
		).toEqual({ tool: "NotebookEdit", file_path: "/n.ipynb" });
	});

	test("non-object input → tool only", () => {
		expect(summarizeToolInput("Task", "raw prompt")).toEqual({ tool: "Task" });
		expect(summarizeToolInput("Task", null)).toEqual({ tool: "Task" });
	});
});

describe("re-audit: token split by a shell line continuation", () => {
	test("masked after joining; idempotent; plain continuations untouched", () => {
		const head = `ghp_${"Q".repeat(18)}`;
		const tail = "R".repeat(18);
		const out = redact(`${head}\\\n${tail}`);
		expect(out).not.toContain(tail);
		expect(out).not.toContain("ghp_");
		expect(redact(out)).toBe(out);
		const plain = "echo a \\\n  && echo b";
		expect(redact(plain)).toBe(plain);
	});
});
