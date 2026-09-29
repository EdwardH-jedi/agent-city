// GET /ws — Bun-native WebSocket pub/sub. Every client subscribes to one topic; the hub publishes
// `{kind, data}` JSON on event / session / repo changes. Server → client only.
import type { WebSocketHandler } from "bun";

export type BroadcastKind = "event" | "session" | "repo";
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
			server?.publish(WS_TOPIC, JSON.stringify({ kind, data }));
		},
	};
}

export const websocket: WebSocketHandler<undefined> = {
	open(ws) {
		ws.subscribe(WS_TOPIC);
	},
	message() {
		// clients don't send anything meaningful
	},
	close(ws) {
		ws.unsubscribe(WS_TOPIC);
	},
};
