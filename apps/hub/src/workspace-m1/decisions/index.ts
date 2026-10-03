// Public surface of the workspace decisions module (role 04). test-support.ts is test-only and
// deliberately not exported.
export {
	createWorkspaceCommands,
	defaultResolveBase,
	storedDraft,
	type WorkspaceCommands,
} from "./commands.ts";
export {
	createDecisionService,
	type DecisionServiceImpl,
	hasDecideScope,
	TRANSIENT_SEAL_ERRORS,
} from "./decision-service.ts";
export type {
	DecisionHooks,
	DecisionTxPoint,
	WorkspaceServiceDeps,
} from "./deps.ts";
export {
	createManagedBridge,
	engineViewOf,
	type ManagedBridgeDeps,
	scrubDetail,
} from "./engine.ts";
export {
	DecisionAbort,
	fail,
	issuesOf,
	mapKnownError,
	ok,
	ResponseContractError,
} from "./outcome.ts";
export {
	createWorkspaceReadModel,
	decisionView,
	type ReadModelDeps,
	requestView,
	taskSummary,
	type WorkspaceReadModel,
} from "./read-model.ts";
export {
	createWorkspaceRouter,
	createWorkspaceServices,
	type WorkspaceApiDeps,
	type WorkspaceAuthPort,
	type WorkspaceServices,
} from "./router.ts";
