// GET /ws — Bun-native WebSocket pub/sub. Every client subscribes to one topic; the hub publishes
// `{kind, data}` JSON on event / session / repo / machine / run / usage changes, and
// `{kind:"invalidate", scope:[…]}` when existing rows were rewritten in bulk (repo remap) so clients
// re-fetch those snapshots (N07). On open a socket may also get one greeting (today: the 7-day token
// usage summary as `{kind:"usage"}`), so the board needs no extra request and an older hub that has no
// usage simply says nothing. Server → client only.
import type { WebSocketHandler } from "bun";

export type BroadcastKind =
	| "event"
	| "session"
	| "repo"
	| "machine"
	| "run"
	| "usage"
	| "invalidate";
export type InvalidateScope = "sessions" | "events" | "repos";
export type Publish = (kind: BroadcastKind, data: unknown) => void;

export const WS_TOPIC = "city";

/** The one Server method we need (Bun's Server type is generic; keep this decoupled). */
interface Publisher {
	publish(topic: string, data: string): number;
}

export interface Broadcaster {
	publish: Publish;
	attach(server: Publisher): void;
}

/** Publishes are dropped until a server is attached (e.g. in unit tests or during startup). */
export function createBroadcaster(): Broadcaster {
	let server: Publisher | null = null;
	return {
		attach(s) {
			server = s;
		},
		publish(kind, data) {
			const msg =
				kind === "invalidate"
					? { kind, scope: (data as { scope: InvalidateScope[] }).scope }
					: { kind, data };
			server?.publish(WS_TOPIC, JSON.stringify(msg));
		},
	};
}

/**
 * The /ws handler. `greet` builds one message sent to each socket right after it subscribes; a greeting
 * that throws or returns null is skipped, never failing the open.
 */
export function createWebsocket(
	greet?: () => string | null,
): WebSocketHandler<undefined> {
	return {
		open(ws) {
			ws.subscribe(WS_TOPIC);
			if (!greet) return;
			try {
				const msg = greet();
				if (msg) ws.send(msg);
			} catch (err) {
				console.error(`[hub] /ws greeting failed: ${(err as Error).name}`);
			}
		},
		message() {
			// clients don't send anything meaningful
		},
		close(ws) {
			ws.unsubscribe(WS_TOPIC);
		},
	};
}

/** The handler without a greeting. */
export const websocket: WebSocketHandler<undefined> = createWebsocket();
