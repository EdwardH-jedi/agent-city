// Agent-browser owns the fresh local browser. Keep this CDP connection alive only while AB4
// observes the transition; closing a CDP session would otherwise remove its emulation override.
import { readFileSync } from "node:fs";

const config: { endpoint: string; targetId: string } = JSON.parse(
	readFileSync(0, "utf8"),
);
const endpoint = new URL(config.endpoint);
if (
	endpoint.protocol !== "ws:" ||
	!["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
	!endpoint.pathname.startsWith("/devtools/browser/") ||
	endpoint.username ||
	endpoint.password ||
	!/^[a-f0-9]+$/i.test(config.targetId)
)
	throw new Error("CPU emulation requires the owned local browser and tab");

const ws = new WebSocket(endpoint);
let nextId = 0;
const pending = new Map<
	number,
	{
		resolve: (value: Record<string, unknown>) => void;
		reject: (error: Error) => void;
	}
>();
ws.addEventListener("message", (event) => {
	const reply = JSON.parse(String(event.data));
	const request = pending.get(reply.id);
	if (!request) return;
	pending.delete(reply.id);
	if (reply.error) request.reject(new Error(reply.error.message));
	else request.resolve(reply.result ?? {});
});
async function send(
	method: string,
	params: Record<string, unknown>,
	sessionId?: string,
) {
	const id = ++nextId;
	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`CDP timeout: ${method}`));
		}, 10_000);
		pending.set(id, {
			resolve(value) {
				clearTimeout(timer);
				resolve(value);
			},
			reject(error) {
				clearTimeout(timer);
				reject(error);
			},
		});
		ws.send(JSON.stringify({ id, method, params, sessionId }));
	});
}

await new Promise<void>((resolve, reject) => {
	ws.addEventListener("open", () => resolve(), { once: true });
	ws.addEventListener("error", () => reject(new Error("Local CDP failed")), {
		once: true,
	});
});
let sessionId: string | undefined;
try {
	const attached = await send("Target.attachToTarget", {
		targetId: config.targetId,
		flatten: true,
	});
	if (typeof attached.sessionId !== "string") throw new Error("No CDP session");
	sessionId = attached.sessionId;
	await send("Emulation.setCPUThrottlingRate", { rate: 8 }, sessionId);
	console.log(JSON.stringify({ ready: true, rate: 8 }));
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, 240_000);
		process.once("SIGTERM", () => {
			clearTimeout(timer);
			resolve();
		});
	});
} finally {
	if (sessionId) {
		await send("Emulation.setCPUThrottlingRate", { rate: 1 }, sessionId);
		await send("Target.detachFromTarget", { sessionId });
	}
	ws.close();
}
