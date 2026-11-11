import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { RUNS_MAX_BODY_BYTES, RunsPayload } from "@agent-city/schema";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { upsertRuns } from "../store.ts";
import type { Publish } from "./ws.ts";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time compare; hashing first makes the inputs equal-length. */
function tokenMatches(given: string, expected: string): boolean {
	return timingSafeEqual(digest(given), digest(expected));
}

export interface RunsDeps {
	db: Database;
	/**
	 * OFFICE_PROJECTION_TOKEN. Unset / empty → the route is disabled (503). It is deliberately NOT the
	 * collector `INGEST_TOKEN`: forge and spine collectors can post session events but never run state.
	 */
	officeToken: string | undefined;
	publish: Publish;
	now?: () => Date;
}

// POST /ingest/runs — the cockpit's read-only report of its Agent Office runs. City stores and shows
// it as "reported"; nothing here (or anywhere in City) approves, launches or retries a run. The body
// is never echoed back or logged, and an error names a field path or a fixed phrase, not caller text.
export function createRunsIngest({
	db,
	officeToken,
	publish,
	now = () => new Date(),
}: RunsDeps): Hono {
	const runs = new Hono();

	runs.post(
		"/",
		async (c, next) => {
			if (!officeToken)
				return c.json({ error: "run projection disabled" }, 503);
			const header = c.req.header("authorization") ?? "";
			const m = /^Bearer\s+(.+)$/i.exec(header);
			if (!m?.[1] || !tokenMatches(m[1].trim(), officeToken)) {
				return c.json({ error: "unauthorized" }, 401);
			}
			await next();
		},
		bodyLimit({
			maxSize: RUNS_MAX_BODY_BYTES,
			onError: (c) => c.json({ error: "payload too large" }, 413),
		}),
		async (c) => {
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json({ error: "invalid JSON" }, 400);
			}
			const parsed = RunsPayload.safeParse(raw);
			if (!parsed.success) {
				// An unrecognized key's own message names the key; never reflect caller-chosen text.
				const issues = parsed.error.issues
					.slice(0, 20)
					.map((i) =>
						i.code === "unrecognized_keys"
							? { path: i.path.join("."), message: "unknown key" }
							: { path: i.path.join("."), message: i.message },
					);
				return c.json({ error: "invalid payload", issues }, 400);
			}
			// Only the cockpit runs Agent Office. A well-formed report from any other machine is refused.
			if (parsed.data.machine_id !== "cockpit") {
				return c.json({ error: "machine not allowed" }, 403);
			}
			const result = upsertRuns(db, parsed.data, now());
			for (const v of result.views) publish("run", v);
			return c.json({ applied: result.applied, ignored: result.ignored });
		},
	);

	return runs;
}
