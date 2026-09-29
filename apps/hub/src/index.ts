import { Hono } from "hono";
import { openDb } from "./db.ts";
import { api } from "./routes/api.ts";
import { ingest } from "./routes/ingest.ts";
import { ws } from "./routes/ws.ts";

export const app = new Hono();

app.get("/healthz", (c) =>
	c.json({
		ok: true,
		machine: process.env.AGENTCITY_MACHINE ?? null,
		time: new Date().toISOString(),
	}),
);

app.route("/ingest", ingest);
app.route("/api", api);
app.route("/ws", ws);

if (import.meta.main) {
	const hostname = process.env.HUB_HOST ?? process.env.HOST ?? "127.0.0.1";
	const port = Number(process.env.HUB_PORT ?? process.env.PORT ?? 4317);
	const dbPath = process.env.DB_PATH ?? "./data/agentcity.db";

	openDb(dbPath);
	const server = Bun.serve({ hostname, port, fetch: app.fetch });
	console.log(
		`[hub] listening on http://${server.hostname}:${server.port} (db: ${dbPath})`,
	);
}
