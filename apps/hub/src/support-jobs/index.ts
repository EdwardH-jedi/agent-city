// Support Lane core (read-only): pure domain, state machine, scheduler and executor contract for
// high-volume informational jobs that stay outside the managed implementation pipeline.
// No model invocation, persistence, HTTP route, UI or Git mutation lives here — see
// docs/support-lane.md. Capability / profile vocabulary: ./vocabulary.ts (single swap point).
export {
	artifactIdFor,
	type OutputValidation,
	resultMetaFor,
	SupportArtifact,
	SupportArtifactBody,
	validateExecutorOutput,
} from "./artifact.ts";
export {
	buildSupportExecutorInput,
	runSupportJob,
	type SupportExecutor,
	type SupportExecutorContext,
	type SupportExecutorInput,
	type SupportRunError,
	type SupportRunResult,
} from "./executor.ts";
export {
	createFakeSupportExecutor,
	type FakeSupportExecutor,
	fakeSupportBody,
} from "./fake-executor.ts";
export {
	createSupportJob,
	parseSupportJob,
	REQUIRED_REF_KINDS,
	SUPPORT_FAILURE_CLASSES,
	SUPPORT_JOB_KINDS,
	SUPPORT_JOB_STATUSES,
	type SupportCreateResult,
	SupportFailure,
	SupportFailureClass,
	SupportInputRef,
	SupportJob,
	SupportJobKind,
	SupportJobMeta,
	SupportJobRequest,
	SupportJobStatus,
	SupportRepoId,
	SupportResultMeta,
} from "./job.ts";
export {
	compareSupportJobs,
	DEFAULT_SUPPORT_CONCURRENCY,
	isSchedulableSupportJob,
	MAX_SUPPORT_CONCURRENCY,
	MAX_SUPPORT_SCHEDULER_INPUT,
	MIN_SUPPORT_CONCURRENCY,
	SUPPORT_SCHEDULE_HARD_CAP,
	type SupportSchedule,
	SupportSchedulerOptions,
	selectSupportJobs,
} from "./scheduler.ts";
export {
	assignSupportProfile,
	canSupportTransition,
	completeSupportJob,
	failSupportJob,
	isTerminalSupportStatus,
	requestSupportCancel,
	SUPPORT_JOB_TRANSITIONS,
	type SupportTransitionError,
	type SupportTransitionResult,
	startSupportJob,
	TERMINAL_SUPPORT_STATUSES,
	transitionSupportJob,
} from "./state.ts";
export {
	SUPPORT_CAPABILITIES,
	SupportCapability,
	SupportProfileId,
} from "./vocabulary.ts";
