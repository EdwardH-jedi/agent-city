// Workspace auth (role 03) — public surface for the lead's `/api/workspace` wiring and for 04.
export {
	createWorkspaceAuth,
	type WorkspaceAuth,
	type WorkspaceAuthSettings,
} from "./auth.ts";
export {
	ChallengePortError,
	type VerifyResult,
	WorkspaceChallenges,
} from "./challenges.ts";
export {
	CHALLENGE_TTL_MAX_MS,
	type Clock,
	SESSION_TTL_MAX_MS,
	type WorkspaceAuthOptions,
} from "./config.ts";
export { SESSION_COOKIE } from "./http.ts";
