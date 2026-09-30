// Re-audit N03: the event id recipe must not change across the id-namespace work. The fixture was
// produced by running the 1f4f025 mappers (scripts/gen-golden-event-ids.ts) on these same inputs.
import { describe, expect, test } from "bun:test";
import { mapClaudeHook } from "../claude-map.ts";
import { type CodexFileContext, mapCodexLine } from "../codex-map.ts";
import {
	claudeCases,
	codexCases,
	GOLDEN_COMMIT,
	lineOffsets,
} from "./cases.ts";
import golden from "./event-ids.1f4f025.json";

const ctx = {
	machine: "golden",
	hostname: "golden",
	now: () => new Date("2026-09-29T00:00:00.000Z"),
	newId: () => "golden-fixed-id",
	git: () => null,
};

describe(`event ids are identical to ${GOLDEN_COMMIT}`, () => {
	expect(golden.commit).toBe(GOLDEN_COMMIT);

	test.each(claudeCases().map((c) => [c.name, c.input] as const))(
		"claude %s",
		(name, input) => {
			const ev = mapClaudeHook(structuredClone(input), ctx);
			expect(ev?.id).toBe((golden.claude as Record<string, string>)[name]);
		},
	);

	test.each(codexCases().map((c) => [c.name, c.lines] as const))(
		"codex %s",
		(name, lines) => {
			const fileCtx: CodexFileContext = { session: null, calls: new Map() };
			const offsets = lineOffsets(lines);
			const ids = lines
				.map((l, i) => mapCodexLine(l, offsets[i] ?? 0, fileCtx, ctx))
				.filter((e) => e !== null)
				.map((e) => e.id);
			const want = (golden.codex as Record<string, string[]>)[name] ?? [];
			expect(ids).toEqual(want);
		},
	);

	test("fixture holds no secret-shaped value", () => {
		expect(JSON.stringify(golden)).not.toMatch(/gh[pousr]_/i);
	});
});
