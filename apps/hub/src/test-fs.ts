// Filesystem capability probes shared by tests (not a test file; never imported by production code).
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Windows has no POSIX permission bits (access is NTFS ACLs inherited from the parent dir). */
export const WIN = process.platform === "win32";

/**
 * Can this process create a *file* symlink? Always true on POSIX; on Windows it needs a privilege
 * (Developer Mode / admin) that a service account often lacks. Directory junctions
 * (`symlinkSync(target, path, "junction")`) need no privilege and are used instead where a test
 * only needs "a link to a directory".
 */
export const CAN_FILE_SYMLINK: boolean = (() => {
	const d = mkdtempSync(join(tmpdir(), "ac-probe-"));
	try {
		writeFileSync(join(d, "t"), "");
		symlinkSync(join(d, "t"), join(d, "l"));
		return true;
	} catch {
		return false;
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
})();
