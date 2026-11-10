// City only observes Agent Office runs (it is not a second Dispatcher). This scans the code that
// serves and shows runs and fails if anything there could approve, launch or retry a run: no control
// in the run screen, no write route on the read API, no request sent from the web view other than
// GET. Comments are stripped first, so explaining the rule in prose is fine.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const code = (p: string) =>
	readFileSync(join(ROOT, p), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/\s\/\/.*$/gm, "");

const ACTION_WORDS = /approve|launch|retry|retri(?:es|ed)/i;

describe("City cannot act on a run", () => {
	test("the run screen renders text only: no button, form, handler or request", () => {
		const src = code("apps/web/src/Runs.tsx");
		expect(src).not.toMatch(
			/<button|<form|<input|<select|onClick|onSubmit|onChange/,
		);
		expect(src).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket/);
		expect(src).not.toMatch(ACTION_WORDS);
	});

	test("the web view sends only GETs", () => {
		const hub = code("apps/web/src/useHub.ts");
		expect(hub).not.toMatch(/method\s*:/);
		expect(hub).not.toMatch(ACTION_WORDS);
		expect(code("apps/web/src/App.tsx")).not.toMatch(/method\s*:/);
	});

	test("the read API has no write route and no action path", () => {
		const api = code("apps/hub/src/routes/api.ts");
		expect(api).not.toMatch(/\bapi\.(post|put|patch|delete|all)\(/);
		expect(api).not.toMatch(ACTION_WORDS);
	});

	test("the only way in is POST /ingest/runs, and it stores a report", () => {
		const runs = code("apps/hub/src/routes/runs.ts");
		expect(runs).not.toMatch(ACTION_WORDS);
		const routes = runs.match(/\bruns\.(post|put|patch|delete|get|all)\(/g);
		expect(routes).toEqual(["runs.post("]);
	});
});
