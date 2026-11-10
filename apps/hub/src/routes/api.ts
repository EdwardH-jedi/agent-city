import type { Database } from "bun:sqlite";
import { MachineRole, Provider, SessionStatus } from "@agent-city/schema";
import { Hono } from "hono";
import {
	listAgents,
	listEvents,
	listMachines,
	listReposByDistrict,
	listRunEvents,
	listRuns,
	listSessions,
} from "../store.ts";

const EVENTS_DEFAULT_LIMIT = 200;
const EVENTS_MAX_LIMIT = 1000;

// Read-only JSON API for the web view. Loopback-only like the rest of the hub (no auth).
export function createApi(
	db: Database,
	now: () => Date = () => new Date(),
): Hono {
	const api = new Hono();

	// Always the three machines (cockpit, forge, spine); one never heard from is `unobserved`.
	api.get("/machines", (c) => c.json({ machines: listMachines(db, now()) }));

	// Runs the cockpit reported (read-only). `display` is `snapshot_stale` once a report is 90 s old or
	// the machine is offline; there is no route here that approves, launches or retries anything.
	api.get("/runs", (c) => c.json({ runs: listRuns(db, now()) }));

	// ?limit=200 — a run's recent events, newest first.
	api.get("/runs/:machine/:id/events", (c) => {
		const machine = MachineRole.safeParse(c.req.param("machine"));
		if (!machine.success) return c.json({ error: "unknown machine" }, 400);
		const limitRaw = c.req.query("limit");
		const limit = limitRaw === undefined ? 200 : Number(limitRaw);
		if (!Number.isInteger(limit) || limit < 1) {
			return c.json({ error: "limit must be a positive integer" }, 400);
		}
		return c.json({
			events: listRunEvents(
				db,
				machine.data,
				c.req.param("id"),
				Math.min(limit, 1000),
			),
		});
	});

	api.get("/repos", (c) => c.json({ districts: listReposByDistrict(db) }));

	// ?status=waiting,active (comma list, optional)
	api.get("/sessions", (c) => {
		const raw = c.req.query("status");
		const wanted = raw ? raw.split(",").map((s) => s.trim()) : [];
		const statuses: SessionStatus[] = [];
		for (const s of wanted) {
			const r = SessionStatus.safeParse(s);
			if (!r.success) return c.json({ error: `unknown status: ${s}` }, 400);
			statuses.push(r.data);
		}
		return c.json({ sessions: listSessions(db, statuses) });
	});

	api.get("/sessions/:id/agents", (c) =>
		c.json({ agents: listAgents(db, c.req.param("id")) }),
	);

	// ?since=<ISO, exclusive>&repo=owner/name&provider=claude&limit=200
	api.get("/events", (c) => {
		const since = c.req.query("since") ?? null;
		if (since !== null && Number.isNaN(Date.parse(since))) {
			return c.json({ error: "since must be ISO-8601" }, 400);
		}
		const provider = c.req.query("provider") ?? null;
		if (provider !== null && !Provider.safeParse(provider).success) {
			return c.json({ error: `unknown provider: ${provider}` }, 400);
		}
		const limitRaw = c.req.query("limit");
		const limit =
			limitRaw === undefined ? EVENTS_DEFAULT_LIMIT : Number(limitRaw);
		if (!Number.isInteger(limit) || limit < 1) {
			return c.json({ error: "limit must be a positive integer" }, 400);
		}
		return c.json({
			events: listEvents(db, {
				since,
				repo: c.req.query("repo") ?? null,
				provider,
				limit: Math.min(limit, EVENTS_MAX_LIMIT),
			}),
		});
	});

	return api;
}
