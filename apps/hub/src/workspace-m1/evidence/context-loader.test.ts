// Context loader: real git objects in disposable repos, plus fake runners for failure modes.
import { afterAll, expect, test } from "bun:test";
import {
	type GitRunner,
	loadBlob,
	loadDiffContexts,
} from "./context-loader.ts";
import { listDiffFiles } from "./diff-parse.ts";
import { cleanupFixtures, scenario } from "./git-fixture.ts";

afterAll(cleanupFixtures);

const text = (b: { kind: string; bytes?: Uint8Array }) =>
	b.kind === "bytes" ? new TextDecoder().decode(b.bytes) : b.kind;

test("reads exact old/new bytes from the two commits; added/deleted sides are absent", async () => {
	const s = scenario(
		{ "m.txt": "old\r\n", "gone.txt": "bye\n", "dir/deep.txt": "d1\n" },
		{
			"m.txt": "new\r\n",
			"gone.txt": null,
			"add.txt": "hi\n",
			"dir/deep.txt": "d2\n",
		},
	);
	const got = await loadDiffContexts(s.git, listDiffFiles(s.diff), {
		old_rev: s.base,
		new_rev: s.head,
	});
	const view = got.map((e) => [
		e.old_path,
		e.new_path,
		text(e.old),
		text(e.new),
	]);
	expect(view).toEqual([
		[null, "add.txt", "absent", "hi\n"],
		["dir/deep.txt", "dir/deep.txt", "d1\n", "d2\n"],
		["gone.txt", null, "bye\n", "absent"],
		["m.txt", "m.txt", "old\r\n", "new\r\n"],
	]);
});

test("symlinks, directories, missing paths, bad revisions and bad paths are refused", async () => {
	const s = scenario(
		{ link: { symlink: "t" }, "d/f.txt": "x\n" },
		{ "d/f.txt": "y\n" },
	);
	expect(await loadBlob(s.git, s.base, "link", 1000)).toEqual({
		kind: "unavailable",
		reason: "special_file",
	});
	expect((await loadBlob(s.git, s.base, "d", 1000)).kind).toBe("unavailable");
	expect(await loadBlob(s.git, s.base, "nope.txt", 1000)).toEqual({
		kind: "unavailable",
		reason: "not_found",
	});
	expect(await loadBlob(s.git, s.base, "d/*", 1000)).toEqual({
		kind: "unavailable",
		reason: "not_found",
	}); // literal pathspecs: no glob
	for (const [rev, path] of [
		["HEAD", "d/f.txt"],
		[s.base.slice(0, 12), "d/f.txt"],
		[s.base, "../x"],
		[s.base, "/etc/hosts"],
		[s.base, ""],
	] as const)
		expect(await loadBlob(s.git, rev, path, 1000)).toEqual({
			kind: "unavailable",
			reason: "bad_request",
		});
});

test("oversized blobs are refused from `cat-file -s` without reading their content", async () => {
	const s = scenario(
		{ "big.txt": "z".repeat(5000) },
		{ "big.txt": "y".repeat(5000) },
	);
	const calls: string[][] = [];
	const spy: GitRunner = (args, max) => {
		calls.push([...args]);
		return s.git(args, max);
	};
	expect(await loadBlob(spy, s.base, "big.txt", 4096)).toEqual({
		kind: "unavailable",
		reason: "oversized",
	});
	expect(calls.some((c) => c[0] === "cat-file" && c[1] === "blob")).toBe(false);
});

test("a non-UTF-8 blob is reported undecodable (the runner's decode is caught by the blob id)", async () => {
	const s = scenario(
		{ "l.txt": Uint8Array.from([0x63, 0xe9, 0x0a]) },
		{ "l.txt": "x\n" },
	);
	expect(await loadBlob(s.git, s.base, "l.txt", 1000)).toEqual({
		kind: "unavailable",
		reason: "undecodable",
	});
});

test("runner failures: timeout, truncation, altered content", async () => {
	const s = scenario({ "f.txt": "abc\n" }, { "f.txt": "abd\n" });
	const wrap =
		(
			edit: (
				args: readonly string[],
				r: Awaited<ReturnType<GitRunner>>,
			) => typeof r,
		): GitRunner =>
		async (args, max) =>
			edit(args, await s.git(args, max));
	const isBlob = (a: readonly string[]) =>
		a[0] === "cat-file" && a[1] === "blob";
	const timeout = wrap((a, r) => (isBlob(a) ? { ...r, timedOut: true } : r));
	expect(await loadBlob(timeout, s.base, "f.txt", 100)).toEqual({
		kind: "unavailable",
		reason: "timeout",
	});
	const trunc = wrap((a, r) =>
		isBlob(a) ? { ...r, stdoutTruncated: true } : r,
	);
	expect(await loadBlob(trunc, s.base, "f.txt", 100)).toEqual({
		kind: "unavailable",
		reason: "unreadable",
	});
	const altered = wrap((a, r) => (isBlob(a) ? { ...r, stdout: "xyz\n" } : r));
	expect(await loadBlob(altered, s.base, "f.txt", 100)).toEqual({
		kind: "unavailable",
		reason: "undecodable",
	});
	const failing = wrap((_a, r) => ({ ...r, exitCode: 128 }));
	expect(await loadBlob(failing, s.base, "f.txt", 100)).toEqual({
		kind: "unavailable",
		reason: "unreadable",
	});
});

test("total byte budget and file count are enforced across a diff", async () => {
	const s = scenario(
		{ "a.txt": "a".repeat(30), "b.txt": "b".repeat(30), "c.txt": "c\n" },
		{ "a.txt": "A".repeat(30), "b.txt": "B".repeat(30), "c.txt": "C\n" },
	);
	const refs = listDiffFiles(s.diff);
	const budget = await loadDiffContexts(
		s.git,
		refs,
		{ old_rev: s.base, new_rev: s.head },
		{ max_total_bytes: 90 },
	);
	expect(budget.map((e) => [e.old.kind, e.new.kind])).toEqual([
		["bytes", "bytes"],
		["bytes", "unavailable"],
		["unavailable", "unavailable"],
	]);
	const few = await loadDiffContexts(
		s.git,
		refs,
		{ old_rev: s.base, new_rev: s.head },
		{ max_files: 1 },
	);
	expect(few.length).toBe(1);
});
