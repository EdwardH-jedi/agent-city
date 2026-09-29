import { Hono } from "hono";

// TODO(phase-0): WebSocket upgrade that pushes newly ingested events to the web view.
export const ws = new Hono();

ws.all("*", (c) => c.json({ error: "not implemented" }, 501));
