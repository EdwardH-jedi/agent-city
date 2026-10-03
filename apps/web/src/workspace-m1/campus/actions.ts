// Binding of the three campus intents to selection routes (for the lead's integration and the dev
// preview). It receives only a `navigate` function — never the store — and every intent becomes a
// plain selection route; an id the current model does not know is ignored.
import type { Route } from "../route.ts";
import type { CampusActions, CampusModel } from "./presentation.ts";

export function createCampusActions(
	navigate: (route: Route) => void,
	getModel: () => CampusModel,
): CampusActions {
	return {
		selectRepo(repoId) {
			if (!getModel().repos.some((r) => r.repo_id === repoId)) return;
			navigate({ view: "projects", repoId, taskId: null, requestId: null });
		},
		selectTask(taskId) {
			const t = getModel().tasks.find((x) => x.task_id === taskId);
			if (!t) return;
			navigate({
				view: "projects",
				repoId: t.repo_id,
				taskId: t.task_id,
				requestId: null,
			});
		},
		openRequest(requestId) {
			const p = getModel().pending.find((x) => x.request_id === requestId);
			if (!p) return;
			navigate({
				view: "hq",
				repoId: null,
				taskId: p.task_id,
				requestId: p.request_id,
			});
		},
	};
}
