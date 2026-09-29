import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { IngestBatch, IngestEvent } from "@agent-city/schema";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ingestEvents } from "../store.ts";
import type { Publish } from "./ws.ts";

const MAX_BODY_BYTES = 5 * 1024 * 1024;

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time compare; hashing first makes the inputs equal-length. */
function tokenMatches(given: string, expected: string): boolean {
	return timingSafeEqual(digest(given), digest(expected));
}

export interface IngestDeps {
	db: Database;
	/** Unset / empty → ingest disabled (503). */
	ingestToken: string | undefined;
	publish: Publish;
}

// POST /ingest — `Authorization: Bearer $INGEST_TOKEN`, body = IngestEvent | IngestEvent[].
// Never echoes the body back; errors carry zod path/message only.
export function createIngest({ db, ingestToken, publish }: IngestDeps): Hono {
	const ingest = new Hono();

	ingest.post(
		"/",
		async (c, next) => {
			if (!ingestToken) return c.json({ error: "ingest disabled" }, 503);
			const auth = c.req.header("authorization") ?? "";
			const m = /^Bearer\s+(.+)$/i.exec(auth);
			if (!m?.[1] || !tokenMatches(m[1].trim(), ingestToken)) {
				return c.json({ error: "unauthorized" }, 401);
			}
			await next();
		},
		bodyLimit({
			maxSize: MAX_BODY_BYTES,
			onError: (c) => c.json({ error: "payload too large" }, 413),
		}),
		async (c) => {
			let raw: unknown;
			try {
				raw = await c.req.json();
			} catch {
				return c.json({ error: "invalid JSON" }, 400);
			}
			// Validate each shape on its own so issues carry field paths (a union reports none).
			const parsed = Array.isArray(raw)
				? IngestBatch.safeParse(raw)
				: IngestEvent.safeParse(raw);
			if (!parsed.success) {
				const issues = parsed.error.issues.slice(0, 20).map((i) => ({
					path: i.path.join("."),
					message: i.message,
				}));
				return c.json({ error: "invalid payload", issues }, 400);
			}
			const batch = Array.isArray(parsed.data) ? parsed.data : [parsed.data];

			const result = ingestEvents(db, batch);
			// Committed — now fan out.
			for (const e of result.events) publish("event", e);
			for (const s of result.sessions) publish("session", s);

			return c.json({
				accepted: result.accepted,
				duplicates: result.duplicates,
			});
		},
	);

	return ingest;
}
