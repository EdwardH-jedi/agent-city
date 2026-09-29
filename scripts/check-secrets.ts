// Scan git-tracked (and untracked, non-ignored) files for secret-looking strings. Exit 1 on any hit.
// Prints only file:line and the pattern name — never the matched value.
// Patterns are shared with the collector's redaction (packages/schema/src/secret-patterns.ts).
import { SCAN_PATTERNS } from "../packages/schema/src/secret-patterns.ts";

const FORBIDDEN_FILES = [
	/(^|\/)\.env$/,
	/(^|\/)\.env\.(?!example$)[^/]+$/,
	/\.db(-wal|-shm)?$/,
];

const ls = Bun.spawnSync([
	"git",
	"ls-files",
	"-z",
	"--cached",
	"--others",
	"--exclude-standard",
]);
if (ls.exitCode !== 0) {
	console.error("[check:secrets] git ls-files failed");
	process.exit(2);
}
const files = ls.stdout.toString().split("\0").filter(Boolean);

const hits: string[] = [];
for (const path of files) {
	if (FORBIDDEN_FILES.some((re) => re.test(path))) {
		hits.push(`${path}  (file must not be committed)`);
		continue;
	}
	const file = Bun.file(path);
	if (!(await file.exists()) || file.size > 2_000_000) continue;
	const text = await file.text();
	if (text.includes("\0")) continue; // binary

	text.split("\n").forEach((line, i) => {
		for (const { name, re } of SCAN_PATTERNS) {
			if (re.test(line)) hits.push(`${path}:${i + 1}  ${name}`);
		}
	});
}

if (hits.length > 0) {
	console.error(`[check:secrets] ${hits.length} potential secret(s):`);
	for (const h of hits) console.error(`  ${h}`);
	process.exit(1);
}
console.log(`[check:secrets] ok — scanned ${files.length} files`);
