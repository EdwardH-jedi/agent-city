// The only three things the campus may ask for (frozen interface `CampusActions`): select a
// repository, select a task, open an approval document. Nothing here can approve, queue, advance,
// cancel or accept work — and the scene only ever holds the narrowed, frozen object below.
import type { CampusActions, CampusModel } from "./presentation.ts";

export type CampusIntent =
	| { kind: "selectRepo"; id: string }
	| { kind: "selectTask"; id: string }
	| { kind: "openRequest"; id: string };

/** What the canvas reports when a building is clicked (the engine knows nothing else). */
export type ScenePick = { kind: "repo"; id: string } | { kind: "hq" };

/**
 * A frozen object with exactly the three intent methods, forwarding to `actions`. Whatever else
 * the passed object carries (a store, workflow commands…) is unreachable through the result.
 */
export function narrowActions(actions: CampusActions): Readonly<CampusActions> {
	return Object.freeze({
		selectRepo: (repoId: string) => {
			actions.selectRepo(String(repoId));
		},
		selectTask: (taskId: string) => {
			actions.selectTask(String(taskId));
		},
		openRequest: (requestId: string) => {
			actions.openRequest(String(requestId));
		},
	});
}

/** The document Headquarters opens: the one already selected, else the oldest pending one. */
export function hqRequest(model: CampusModel): string | null {
	return (
		model.pending.find((p) => p.selected)?.request_id ??
		model.pending[0]?.request_id ??
		null
	);
}

export function intentForPick(
	pick: ScenePick,
	model: CampusModel,
): CampusIntent | null {
	if (pick.kind === "repo")
		return model.repos.some((r) => r.repo_id === pick.id)
			? { kind: "selectRepo", id: pick.id }
			: null;
	const req = hqRequest(model);
	return req ? { kind: "openRequest", id: req } : null;
}

export function dispatchIntent(
	intent: CampusIntent,
	actions: Readonly<CampusActions>,
): void {
	switch (intent.kind) {
		case "selectRepo":
			actions.selectRepo(intent.id);
			return;
		case "selectTask":
			actions.selectTask(intent.id);
			return;
		case "openRequest":
			actions.openRequest(intent.id);
			return;
	}
}
