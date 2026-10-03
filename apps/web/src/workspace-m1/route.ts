// Selection ↔ URL hash (role 07). Only ids appear in the URL — never a credential, CSRF value,
// challenge or signature. User selections push a history entry (Back/Forward restores the
// selection); normalization of unknown/invalid parts replaces it (N-11). Pure; no DOM.
import {
	ApprovalRequestId,
	RepoId,
	WorkspaceTaskId,
} from "@agent-city/schema/workspace-m1";

export type View = "projects" | "hq" | "activity";

export interface Route {
	view: View;
	repoId: string | null;
	/** Projects: the selected task. HQ: the task of the selected request. */
	taskId: string | null;
	requestId: string | null;
}

export const HOME: Route = {
	view: "projects",
	repoId: null,
	taskId: null,
	requestId: null,
};

const valid = (
	schema: { safeParse(v: unknown): { success: boolean } },
	v: string | undefined,
): string | null => {
	if (v === undefined || v.length === 0) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(v);
	} catch {
		return null;
	}
	return schema.safeParse(decoded).success ? decoded : null;
};

/**
 *   #/projects
 *   #/projects/<repo id, URI-encoded>
 *   #/projects/<repo id>/<wst-…>
 *   #/hq
 *   #/hq/<wst-…>/<wsa-…>
 *   #/activity
 */
export function parseHash(hash: string): Route {
	const parts = hash.replace(/^#\/?/, "").split("/");
	const [view, a, b] = parts;
	if (view === "hq") {
		const taskId = valid(WorkspaceTaskId, a);
		const requestId = taskId ? valid(ApprovalRequestId, b) : null;
		return {
			view: "hq",
			repoId: null,
			taskId: requestId ? taskId : null,
			requestId,
		};
	}
	if (view === "activity") return { ...HOME, view: "activity" };
	const repoId = valid(RepoId, a);
	return {
		view: "projects",
		repoId,
		taskId: repoId ? valid(WorkspaceTaskId, b) : null,
		requestId: null,
	};
}

export function formatHash(r: Route): string {
	if (r.view === "activity") return "#/activity";
	if (r.view === "hq")
		return r.taskId && r.requestId ? `#/hq/${r.taskId}/${r.requestId}` : "#/hq";
	if (!r.repoId) return "#/projects";
	const repo = encodeURIComponent(r.repoId);
	return r.taskId ? `#/projects/${repo}/${r.taskId}` : `#/projects/${repo}`;
}

export const sameRoute = (a: Route, b: Route): boolean =>
	a.view === b.view &&
	a.repoId === b.repoId &&
	a.taskId === b.taskId &&
	a.requestId === b.requestId;
