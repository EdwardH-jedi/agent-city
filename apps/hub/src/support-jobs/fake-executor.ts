// Deterministic fake support executor for tests and local wiring. No model, no clock, no
// randomness: the same input always yields the same body.
import type { SupportArtifactBody } from "./artifact.ts";
import type { SupportExecutor, SupportExecutorInput } from "./executor.ts";
import { SUPPORT_CAPABILITIES, type SupportCapability } from "./vocabulary.ts";

const refList = (input: SupportExecutorInput): string[] =>
	input.inputs.map((r) => `${r.kind}:${r.id}`);

/** The body the fake returns for an input — exported so tests can compare exactly. */
export function fakeSupportBody(
	input: SupportExecutorInput,
): SupportArtifactBody {
	const refs = refList(input);
	const about = `${input.kind} for ${input.repo_id}`;
	const listed = refs.length > 0 ? refs.join(", ") : "no references";
	switch (input.kind) {
		case "REPO_STATUS":
			return {
				kind: "REPO_STATUS",
				title: `Status of ${input.repo_id}`,
				summary: `${about} (${listed}).`,
				highlights: refs,
			};
		case "HANDOFF":
			return {
				kind: "HANDOFF",
				title: `Handoff for ${input.repo_id}`,
				handoff_text: `${about}. Context: ${listed}.`,
				open_questions: [],
			};
		case "LOG_TRIAGE":
			return {
				kind: "LOG_TRIAGE",
				title: `Triage of ${listed}`,
				severity: "info",
				summary: `${about}: nothing alarming in ${listed}.`,
				findings: refs.map((r) => `reviewed ${r}`),
			};
		case "EVIDENCE_SUMMARY":
			return {
				kind: "EVIDENCE_SUMMARY",
				title: `Evidence for ${input.repo_id}`,
				summary: `${about} from ${listed}.`,
				gaps: [],
			};
		case "REVIEW_TO_TODOS":
			return {
				kind: "REVIEW_TO_TODOS",
				title: `TODOs from ${listed}`,
				todos: refs.map((r) => ({ text: `address ${r}`, severity: "minor" })),
			};
		case "PR_DRAFT":
			return {
				kind: "PR_DRAFT",
				draft_title: `Draft: changes in ${input.repo_id}`,
				draft_body: `Draft description covering ${listed}.`,
			};
		case "CONTEXT_PACKAGE":
			return {
				kind: "CONTEXT_PACKAGE",
				title: `Context for ${input.repo_id}`,
				sections: [{ heading: "References", body: listed }],
			};
	}
}

export interface FakeSupportExecutor extends SupportExecutor {
	/** Job ids seen, in call order. */
	readonly calls: readonly string[];
}

export function createFakeSupportExecutor(
	capabilities: readonly SupportCapability[] = SUPPORT_CAPABILITIES,
): FakeSupportExecutor {
	const calls: string[] = [];
	return {
		executor_id: "fake-support",
		capabilities,
		calls,
		async execute(input) {
			calls.push(input.job_id);
			return fakeSupportBody(input);
		},
	};
}
