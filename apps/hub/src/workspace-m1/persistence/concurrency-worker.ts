// Test-only Worker for concurrency.test.ts: opens its OWN Database handle on the shared temp file,
// reports ready, blocks on a SharedArrayBuffer gate until the parent releases every worker at once,
// then performs one operation and reports the outcome. Never imported by production code.
import { ensureWorkspaceSchema } from "./migration.ts";
import { decideRun, openRaw, openWorkspace } from "./testkit.ts";

declare const self: Worker;

export type WorkerJob =
	| { mode: "migrate"; path: string; gate: SharedArrayBuffer }
	| {
			mode: "decide";
			path: string;
			gate: SharedArrayBuffer;
			request_id: string;
			binding_hash: string;
			expected_request_rev: number;
			key: string;
			now: string;
	  };

export type WorkerReply =
	| { type: "ready" }
	| { type: "done"; outcome: string }
	| { type: "error"; message: string };

self.onmessage = (ev: MessageEvent<WorkerJob>) => {
	const job = ev.data;
	const gate = new Int32Array(job.gate);
	const reply = (r: WorkerReply) => self.postMessage(r);
	try {
		if (job.mode === "migrate") {
			const db = openRaw(job.path); // a genuine 007 file; no migration runs on open
			reply({ type: "ready" });
			Atomics.wait(gate, 0, 0);
			const applied = ensureWorkspaceSchema(db);
			db.close();
			reply({ type: "done", outcome: applied ? "applied" : "noop" });
			return;
		}
		const ws = openWorkspace(job.path);
		reply({ type: "ready" });
		Atomics.wait(gate, 0, 0);
		const out = decideRun(ws, {
			request_id: job.request_id,
			binding_hash: job.binding_hash,
			action: "approve",
			key: job.key,
			expected_request_rev: job.expected_request_rev,
			now: job.now,
		});
		ws.db.close();
		reply({ type: "done", outcome: out.kind });
	} catch (err) {
		reply({
			type: "error",
			message: err instanceof Error ? `${err.name}: ${err.message}` : "error",
		});
	}
};
