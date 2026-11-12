// Observation only: record URL and lifecycle, never frames, headers, or credentials.
// The existing constructor (including agent-browser's domain guard) is preserved.
(() => {
	const observation = { websockets: [] };
	Object.defineProperty(window, "__agentCityABObservation", {
		value: observation,
	});
	const Native = window.WebSocket;
	window.WebSocket = new Proxy(Native, {
		construct(target, args, newTarget) {
			const socket = Reflect.construct(target, args, newTarget);
			const row = {
				url: socket.url,
				createdAt: new Date().toISOString(),
				state: "connecting",
			};
			observation.websockets.push(row);
			socket.addEventListener("open", () => {
				row.state = "open";
				row.openedAt = new Date().toISOString();
			});
			socket.addEventListener("close", (e) => {
				row.state = "closed";
				row.closedAt = new Date().toISOString();
				row.code = e.code;
			});
			socket.addEventListener("error", () => {
				row.error = true;
			});
			return socket;
		},
	});
})();
