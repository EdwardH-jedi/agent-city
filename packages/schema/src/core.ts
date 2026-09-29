// zod-free entry for latency-sensitive callers (the Claude hook: zod adds ~10ms of startup).
// Runtime values here must not import types.ts; types are erased at build time.
export {
	COMMAND_MAX,
	clip,
	INPUT_MAX,
	REDACTED,
	redact,
	redactObject,
	summarizeToolInput,
	type ToolInputSummary,
} from "./redact.ts";
export { localRepoId, parseGithubRemote } from "./repo-slug.ts";
export {
	fnv1a64,
	safeId,
	safeText,
	sanitizeEvent,
} from "./sanitize.ts";
export { endsAgent, nextStatus, SUBAGENT_TOOLS } from "./status.ts";
export type { AgentKind, IngestEvent, Provider } from "./types.ts";
