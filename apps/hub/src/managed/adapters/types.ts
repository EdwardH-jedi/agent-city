// Provider adapter contracts. An adapter turns "implement this task in this worktree" or "review
// this candidate" into provider-specific work and reports what actually happened. Adapters never
// touch the DB and never start a process except through ctx.run (the orchestrator's owned,
// cancellable, bounded process boundary).
import type {
	EvidenceManifest,
	ExecutionMode,
	FailureKind,
	ImplementationOutput,
	ManagedProvider,
	ManagedRun,
	ManagedTask,
} from "@agent-city/schema";
import type { RunOptions, RunResult } from "../proc.ts";

export interface AdapterContext {
	/** Aborted on cancel or when the worker lost its lease. */
	signal: AbortSignal;
	/** Spawn an owned child: own process group, recorded pid, bounded output, killed on abort. */
	run(
		opts: Pick<RunOptions, "argv" | "cwd" | "env" | "stdin" | "timeoutMs"> &
			Partial<Pick<RunOptions, "onStdoutLine" | "maxOutputBytes">>,
	): Promise<RunResult>;
	/** A directory outside the worktree for adapter scratch files (schemas, last-message files). */
	scratchDir: string;
	maxLogBytes: number;
}

export interface Preflight {
	ok: boolean;
	kind?: FailureKind;
	detail: string;
	version?: string | null;
}

/** Provider metadata. `null` means the provider did not report it — never a guess. */
export interface ProviderMeta {
	session_ref: string | null;
	model_resolved: string | null;
	usage: Record<string, unknown> | null;
	/** Redacted, bounded transcript of the provider process (protocol output, not reasoning). */
	log: string;
	logTruncated: boolean;
}

export type AdapterFailure = ProviderMeta & {
	ok: false;
	kind: FailureKind;
	detail: string;
};

export interface ImplementInput {
	task: ManagedTask;
	run: ManagedRun;
	worktree: string;
	/** Session of the parent attempt to continue (repairs). Explicit id — never "most recent". */
	resumeSession: string | null;
}

export type ImplementResult =
	| (ProviderMeta & { ok: true; output: ImplementationOutput })
	| AdapterFailure;

export interface ReviewInput {
	task: ManagedTask;
	run: ManagedRun;
	worktree: string;
	candidate_sha: string;
	manifest_hash: string;
	manifest: EvidenceManifest;
	diff: string;
}

/** `raw` is the reviewer's structured output, NOT yet validated — the orchestrator validates it. */
export type ReviewResult =
	| (ProviderMeta & { ok: true; raw: unknown })
	| AdapterFailure;

interface AdapterBase {
	provider: ManagedProvider;
	mode: ExecutionMode;
	model_requested: string | null;
	/** Must not call a model. */
	preflight(ctx: AdapterContext): Promise<Preflight>;
}

export interface ImplementationAdapter extends AdapterBase {
	implement(
		input: ImplementInput,
		ctx: AdapterContext,
	): Promise<ImplementResult>;
}

export interface ReviewAdapter extends AdapterBase {
	review(input: ReviewInput, ctx: AdapterContext): Promise<ReviewResult>;
}

export interface AdapterSet {
	implementer(mode: ExecutionMode): ImplementationAdapter | null;
	reviewer(mode: ExecutionMode): ReviewAdapter | null;
}

export const EMPTY_META: ProviderMeta = {
	session_ref: null,
	model_resolved: null,
	usage: null,
	log: "",
	logTruncated: false,
};
