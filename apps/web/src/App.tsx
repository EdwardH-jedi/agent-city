import { useEffect, useState } from "react";

type Health =
	| { status: "loading" }
	| { status: "ok"; body: unknown }
	| { status: "error"; message: string };

export function App() {
	const [health, setHealth] = useState<Health>({ status: "loading" });

	useEffect(() => {
		fetch("/healthz")
			.then(async (res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				setHealth({ status: "ok", body: await res.json() });
			})
			.catch((err: unknown) =>
				setHealth({ status: "error", message: String(err) }),
			);
	}, []);

	return (
		<main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
			<h1>Agent City — Phase 0</h1>
			<h2>/healthz</h2>
			{health.status === "loading" && <p>loading…</p>}
			{health.status === "error" && <p>hub unreachable: {health.message}</p>}
			{health.status === "ok" && (
				<pre>{JSON.stringify(health.body, null, 2)}</pre>
			)}
		</main>
	);
}
