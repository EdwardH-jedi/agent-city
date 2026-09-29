import { Hono } from "hono";

// TODO(phase-0): read-only JSON API for the web view (machines, repos by district, sessions, recent events).
export const api = new Hono();

api.all("*", (c) => c.json({ error: "not implemented" }, 501));
