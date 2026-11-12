// AGENTCITY_BOARD_URL guard (ab-cli.py): only http://127.0.0.1[:port] is accepted, and the URL the
// check opens is rebuilt from its parsed parts. Shells python3 (the check scripts are Python); skipped
// when python3 is not on PATH.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const python = Bun.which("python3");
const HERE = import.meta.dir;

const PROBE = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('ab_cli', ${JSON.stringify(join(HERE, "ab-cli.py"))})
m = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(m)
    print(json.dumps({'ok': True, 'plain': m.board_url(), 'demo': m.board_url(demo=True)}))
except ValueError as e:
    print(json.dumps({'ok': False, 'error': str(e)}))
`;

function probe(url: string | undefined) {
	const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
	if (url !== undefined) env.AGENTCITY_BOARD_URL = url;
	const run = Bun.spawnSync([python as string, "-I", "-B", "-c", PROBE], {
		env,
	});
	return JSON.parse(run.stdout.toString()) as {
		ok: boolean;
		plain?: string;
		demo?: string;
		error?: string;
	};
}

describe.skipIf(!python)("AGENTCITY_BOARD_URL", () => {
	test("default and merged queries", () => {
		expect(probe(undefined).plain).toBe("http://127.0.0.1:4317/");
		expect(probe("").demo).toBe("http://127.0.0.1:4317/?demo=1");
		const town = probe("http://127.0.0.1:5181/?scene=town");
		expect(town.plain).toBe("http://127.0.0.1:5181/?scene=town");
		expect(town.demo).toBe("http://127.0.0.1:5181/?scene=town&demo=1");
		// an existing demo is replaced, not doubled
		expect(probe("http://127.0.0.1:5181/?demo=1&scene=town").plain).toBe(
			"http://127.0.0.1:5181/?scene=town",
		);
	});

	test("refuses anything but plain http on 127.0.0.1", () => {
		for (const bad of [
			"http://evil.com\\@127.0.0.1/",
			"http://evil.com@127.0.0.1/",
			"http://127.0.0.1@evil.com/",
			"file://localhost/etc/hosts",
			"https://127.0.0.1/",
			"http://localhost:5181/",
			"http://[::1]:5181/",
			"http://127.0.0.1:99999/",
			"http://127.0.0.1/ x",
			"http://example.com/",
		])
			expect(probe(bad).ok).toBe(false);
	});
});
