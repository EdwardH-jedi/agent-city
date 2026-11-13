// zod-free entry for latency-sensitive callers (the Claude hook: zod adds ~10ms of startup).
// Runtime values here must not import types.ts; types are erased at build time.

export {
	isSafeRawId,
	mainAgentId,
	namespaceIds,
	safeRawId,
	scopedAgentId,
	sessionId,
	subagentId,
} from "./ids.ts";
export { MAX_INGEST_BATCH } from "./limits.ts";
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
export {
	GIT_INSTEADOF_MAX,
	GIT_PATH_MAX,
	GIT_REMOTES_MAX,
	GIT_URL_MAX,
	type GitRemote,
	githubRepoFromConfig,
	githubRepoFromRemotes,
	localRepoId,
	normalizeRepoId,
	parseGithubRemote,
	remotesFromConfig,
	repoKey,
} from "./repo-slug.ts";
export {
	fnv1a64,
	safeId,
	safeText,
	sanitizeEvent,
} from "./sanitize.ts";
export { endsAgent, nextStatus, SUBAGENT_TOOLS } from "./status.ts";
export type {
	AgentKind,
	IngestEvent,
	Provider,
	UsageLimit,
	UsageRow,
	UsageTool,
} from "./types.ts";
export {
	dayMinus,
	tokenCount,
	USAGE_FIRST_DAY,
	USAGE_MAX_BODY_BYTES,
	USAGE_MAX_DAYS,
	USAGE_MAX_LIMITS,
	USAGE_MAX_ROWS,
	USAGE_ROW_MAX,
	USAGE_TOKENS_MAX,
	USAGE_TZ,
	usageDay,
	usageLabel,
	usageObservedAt,
	usageProject,
	usageValidDay,
} from "./usage.ts";
