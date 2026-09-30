// Regenerate apps/collector/src/golden/event-ids.<commit>.json (re-audit N03):
//   bun scripts/gen-golden-event-ids.ts [commit]
// Exports <commit> with `git archive` into a temp dir (no refs / worktrees touched), wires its
// node_modules like night/audit-v2/export_baseline.py (per-package workspace links stay relative,
// so @agent-city/schema resolves to the EXPORTED tree's schema), runs that tree's mappers on the
// shared cases and writes only { caseName: eventId }. No secrets end up in the fixture.
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	claudeCases,
	codexCases,
	GOLDEN_COMMIT,
	lineOffsets,
} from "../apps/collector/src/golden/cases.ts";

const repo = resolve(import.meta.dir, "..");
const commit = process.argv[2] ?? GOLDEN_COMMIT;
const dest = mkdtempSync(join(tmpdir(), "agentcity-golden-"));
try {
	const tar = Bun.spawnSync(["git", "-C", repo, "archive", commit], {
		stdout: "pipe",
	});
	if (tar.exitCode !== 0) throw new Error(`git archive ${commit} failed`);
	const untar = Bun.spawnSync(["tar", "-x", "-C", dest], { stdin: tar.stdout });
	if (untar.exitCode !== 0) throw new Error("tar -x failed");
	symlinkSync(join(repo, "node_modules"), join(dest, "node_modules"));
	for (const pkg of [
		"apps/hub",
		"apps/collector",
		"apps/web",
		"packages/schema",
	]) {
		const src = join(repo, pkg, "node_modules");
		if (existsSync(src))
			cpSync(src, join(dest, pkg, "node_modules"), {
				recursive: true,
				verbatimSymlinks: true,
			});
	}

	const claude = await import(join(dest, "apps/collector/src/claude-map.ts"));
	const codex = await import(join(dest, "apps/collector/src/codex-map.ts"));
	const ctx = {
		machine: "golden",
		hostname: "golden",
		now: () => new Date("2026-09-29T00:00:00.000Z"),
		newId: () => "golden-fixed-id",
		git: () => null,
	};
	const out: {
		commit: string;
		claude: Record<string, string>;
		codex: Record<string, string[]>;
	} = {
		commit,
		claude: {},
		codex: {},
	};
	for (const c of claudeCases()) {
		const ev = claude.mapClaudeHook(structuredClone(c.input), ctx);
		if (!ev) throw new Error(`old mapper returned null for ${c.name}`);
		out.claude[c.name] = ev.id;
	}
	for (const c of codexCases()) {
		const fileCtx = { session: null, calls: new Map() };
		const offsets = lineOffsets(c.lines);
		out.codex[c.name] = c.lines
			.map((l, i) => codex.mapCodexLine(l, offsets[i], fileCtx, ctx))
			.filter(Boolean)
			.map((e: { id: string }) => e.id);
	}
	const target = join(
		repo,
		`apps/collector/src/golden/event-ids.${commit}.json`,
	);
	await Bun.write(target, `${JSON.stringify(out, null, "\t")}\n`);
	console.log(`wrote ${target}`);
} finally {
	rmSync(dest, { recursive: true, force: true });
}
