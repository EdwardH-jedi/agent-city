// Rule-level checks of the full-content detector. Values are synthetic placeholders.
import { describe, expect, test } from "bun:test";
import { maskedLine, scanSecretLines } from "./secret-lines.ts";

const scan = (text: string) => {
	const r = scanSecretLines(text.split("\n"));
	return { lines: [...r.lines].sort((a, b) => a - b), why: r.uninterpretable };
};

describe("YAML", () => {
	test("block scalars with chomping/indentation indicators and tags", () => {
		for (const head of [
			"password: |-",
			"token: >+2",
			"secret: !vault |",
			"api_key: >",
		])
			expect(scan(`${head}\n  one\n\n  two\nnext: visible`)).toEqual({
				lines: [0, 1, 2, 3],
				why: null,
			});
	});

	test("block scalar under a sequence item; sibling keys over-masked, next item kept", () => {
		expect(scan("- password: |\n    a\n    b\n- name: x")).toEqual({
			lines: [0, 1, 2],
			why: null,
		});
	});

	test("nested mapping and same-indent sequence under a secret key", () => {
		expect(scan("credentials:\n  user: a\n  pass: b\nport: 1")).toEqual({
			lines: [0, 1, 2],
			why: null,
		});
		expect(scan("passwords:\n- a\n- b\nother: x")).toEqual({
			lines: [0, 1, 2],
			why: null,
		});
	});

	test("multi-line plain, double- and single-quoted values", () => {
		expect(scan("password: first\n  second\nnext: 1").lines).toEqual([0, 1]);
		expect(scan('token: "a \\" b\n  c"\nnext: 1').lines).toEqual([0, 1]);
		expect(scan("secret: 'it''s\n  more'\nnext: 1").lines).toEqual([0, 1]);
	});

	test("flow mappings/sequences spanning lines", () => {
		expect(scan("auth: {user: a,\n  pass: 'x]'}\nnext: 1").lines).toEqual([
			0, 1,
		]);
		expect(scan("tokens: [\n  a,\n  b\n]\nnext: 1").lines).toEqual([
			0, 1, 2, 3,
		]);
	});

	test("an alias under a secret key masks the anchored value", () => {
		expect(
			scan("common: &shared VALUEX\nother: 1\npassword: *shared").lines,
		).toEqual([0, 2]);
	});

	test("explicit `? key` / `: value`", () => {
		expect(scan("? password\n: hidden\nnext: 1").lines).toEqual([0, 1]);
	});

	test("name/value pairs (k8s env) and a top-level pointer", () => {
		expect(
			scan(
				"env:\n  - name: A\n    value: a\n  - name: DB_PASSWORD\n    value: b\n  - name: C",
			).lines,
		).toEqual([3, 4]);
		expect(scan("name: API_TOKEN\nvalue: v\nother: 1\nmore: 2").lines).toEqual([
			0, 1,
		]);
	});

	test("a TAB-indented continuation counts as deeper", () => {
		expect(scan("  secret: x\n\tcontinued\nz: 1").lines).toEqual([0, 1]);
	});
});

describe("other formats", () => {
	test("JSON: key on one line, value on the next; nested objects", () => {
		expect(scan('{\n  "password":\n  "v",\n  "a": 1\n}').lines).toEqual([1, 2]);
		expect(
			scan(
				'{\n  "credentials": {\n    "id": "x",\n    "blob": "y"\n  },\n  "name": "n"\n}',
			).lines,
		).toEqual([1, 2, 3, 4]);
	});

	test(".env multi-line double quotes, TOML triple quotes, heredocs", () => {
		expect(scan('PRIVATE_KEY="l1\nl2\nl3"\nOTHER=1').lines).toEqual([0, 1, 2]);
		expect(scan('password = """\nabc\n"""\nx = 1').lines).toEqual([0, 1, 2]);
		expect(scan("TOKEN=$(cat <<EOF\nabc\nEOF\n)\necho ok").lines).toEqual([
			0, 1, 2,
		]);
	});

	test("XML elements and Dockerfile ENV", () => {
		expect(
			scan("<password>\n  abc\n</password>\n<user>u</user>").lines,
		).toEqual([0, 1, 2]);
		expect(scan("FROM x\nENV API_TOKEN abcdef\nRUN true").lines).toEqual([1]);
	});

	test("over-long lines are masked whole", () => {
		expect(scan(`ok\n${"x".repeat(5000)}\nok`).lines).toEqual([1]);
	});
});

describe("fail closed", () => {
	test("unterminated structures under a secret key are uninterpretable", () => {
		expect(scan('password: "open\nmore').why).toBe("unterminated_quote");
		expect(scan("token: {a: 1\nb: 2").why).toBe("unterminated_flow");
		expect(scan("SECRET=$(cat <<END\nabc").why).toBe("unterminated_heredoc");
		expect(scan("auth_blob: '''\nabc").why).toBe("unterminated_quote");
	});

	test("the step budget bounds pathological input", () => {
		// every line is a secret key whose value block runs to the end of the file
		const lines = Array.from(
			{ length: 3000 },
			(_, i) => `${" ".repeat(i)}secret:`,
		);
		const r = scanSecretLines(lines);
		expect(r.uninterpretable).toBe("scan_budget");
	});
});

test("clean content is not marked", () => {
	expect(
		scan(
			"name: demo\nport: 8080\nlabels:\n  - a\n  - b\nauthor: someone\nmax_tokens: 5",
		).lines,
	).toEqual([]);
});

test("maskedLine keeps indentation and CR, never the content", () => {
	expect(maskedLine("    value: x\r")).toBe("    [REDACTED]\r");
	expect(maskedLine("  ")).toBe("  ");
});
