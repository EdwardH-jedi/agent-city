// React binding of the workspace store (role 07): subscription, polling (2 s reads, 1 s clock),
// and selection ↔ URL hash (push on user selection, replace on normalization, Back/Forward →
// navigate). Holds no state of its own.
import { useEffect, useSyncExternalStore } from "react";
import { formatHash, parseHash } from "./route.ts";
import type { WorkspaceStore, WsState } from "./store.ts";

export const POLL_MS = 2_000;
export const CLOCK_MS = 1_000;

export function useWorkspaceState(store: WorkspaceStore): WsState {
	return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function useWorkspaceRuntime(
	store: WorkspaceStore,
	route: WsState["route"],
	routeMode: WsState["routeMode"] = "push",
): void {
	useEffect(() => {
		void store.boot();
		const poll = setInterval(() => void store.refresh(), POLL_MS);
		const clock = setInterval(() => store.tick(), CLOCK_MS);
		const onHistory = () => store.navigate(parseHash(location.hash));
		window.addEventListener("popstate", onHistory);
		window.addEventListener("hashchange", onHistory);
		return () => {
			clearInterval(poll);
			clearInterval(clock);
			window.removeEventListener("popstate", onHistory);
			window.removeEventListener("hashchange", onHistory);
		};
	}, [store]);

	useEffect(() => {
		const want = formatHash(route);
		if (location.hash === want) return;
		const current = parseHash(location.hash);
		// the URL already names this selection, only spelled differently → normalize in place
		// same selection spelled differently, or a normalization by the store → replace in place
		if (formatHash(current) === want || routeMode === "replace")
			history.replaceState(null, "", want);
		else history.pushState(null, "", want);
	}, [route, routeMode]);
}
