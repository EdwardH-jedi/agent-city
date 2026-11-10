// Test helper (imported only by *.test.ts). A test that needs a POSIX shell, `mkfifo`, executable
// bits or POSIX kill semantics cannot run on Windows: it is reported as skipped there, never as a
// silent pass. Each use carries a `// POSIX-only: <why>` comment. See README "Running the tests on
// Windows".
import { test } from "bun:test";

export const isWindows = process.platform === "win32";

/** `test`, skipped on win32. */
export const posixOnly = test.skipIf(isWindows);
