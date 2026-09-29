import { Hono } from "hono";

// TODO(phase-0): POST /ingest/events — verify `Authorization: Bearer $INGEST_TOKEN`,
// validate with schema.Event, insert idempotently (INSERT OR IGNORE on events.id).
export const ingest = new Hono();

ingest.all("*", (c) => c.json({ error: "not implemented" }, 501));
