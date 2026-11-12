// Two screens over one hub connection: the board (default: status, HQ queue, project village, what is
// running now) and the detail screen (#/detail, key D; Detail.tsx, in the board's panel look since 16 A3).
import { lazy, Suspense, useEffect, useState } from "react";
import { Board } from "./board/Board.tsx";
import { isDemo } from "./board/demo-flag.ts";
import { Detail } from "./Detail.tsx";
import { type EventFilter, useHub } from "./useHub.ts";

type Route = "board" | "detail";
const routeOf = (): Route =>
	window.location.hash === "#/detail" ? "detail" : "board";

// The hash picks the screen; the D key flips it (not while typing in a filter).
function useRoute(): Route {
	const [route, setRoute] = useState<Route>(routeOf);
	useEffect(() => {
		const onHash = () => setRoute(routeOf());
		const onKey = (e: KeyboardEvent) => {
			if (e.key.toLowerCase() !== "d" || e.ctrlKey || e.metaKey || e.altKey)
				return;
			const tag = (e.target as HTMLElement | null)?.tagName;
			if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
			window.location.hash = routeOf() === "detail" ? "#/" : "#/detail";
		};
		window.addEventListener("hashchange", onHash);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("hashchange", onHash);
			window.removeEventListener("keydown", onKey);
		};
	}, []);
	return route;
}

// the made-up data is a separate chunk: the live path never downloads it (§13.9)
const DemoBoard = lazy(() => import("./board/DemoBoard.tsx"));

/** `?demo=1` draws the board from made-up data and never opens the hub connection. */
export function App() {
	return isDemo(window.location.search) ? (
		<Suspense fallback={null}>
			<DemoBoard />
		</Suspense>
	) : (
		<LiveApp />
	);
}

function LiveApp() {
	const [filter, setFilter] = useState<EventFilter>({
		repo: null,
		provider: null,
	});
	const hub = useHub(filter);
	const route = useRoute();
	return route === "detail" ? (
		<Detail hub={hub} filter={filter} setFilter={setFilter} />
	) : (
		<Board hub={hub} />
	);
}
