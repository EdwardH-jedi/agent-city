// Test-only child process for restart.test.ts: performs one Gate-1 approval on a temp database and
// dies hard at a chosen point — inside the transaction (after the nested requestRun) or right after
// COMMIT before any response is produced. Never imported by production code.
import { decideRun, openWorkspace } from "./testkit.ts";

interface CrashJob {
	mode: "exit_inside_tx" | "exit_after_commit";
	request_id: string;
	binding_hash: string;
	expected_request_rev: number;
	key: string;
	now: string;
}

const [path, raw] = process.argv.slice(2);
if (!path || !raw) process.exit(2);
const job = JSON.parse(raw) as CrashJob;
const ws = openWorkspace(path, {
	hooks:
		job.mode === "exit_inside_tx"
			? {
					enqueue: (point) => {
						if (point === "after_request_run") process.exit(17);
					},
				}
			: undefined,
});
decideRun(ws, {
	request_id: job.request_id,
	binding_hash: job.binding_hash,
	action: "approve",
	key: job.key,
	expected_request_rev: job.expected_request_rev,
	now: job.now,
});
// committed; the "response" is never sent
process.exit(job.mode === "exit_after_commit" ? 18 : 0);
