import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	FIXTURE_CHALLENGE_TOKEN,
	IDS,
	sampleGraph,
} from "./fixtures/sample.ts";
import vectors from "./fixtures/vectors.json";
import {
	approvalBindingHash,
	canonicalEncode,
	challengeExpiry,
	challengeHash,
	challengeValid,
	createTaskRequestHash,
	newBootId,
	newToken256,
	newWorkspaceId,
	proposalHash,
	seal,
	sha256Hex,
	storedCanonicalMatches,
} from "./hash.ts";
import {
	BootId,
	CHALLENGE_TTL_MS,
	ChallengeBinding,
	DecisionPayload,
	ExecutionBinding,
	emptyDraft,
	ProposalSnapshot,
	ResultApprovalBinding,
	ResultEnvelope,
	ReviewRecord,
	RunApprovalBinding,
	Token256,
	WORKSPACE_ID_PATTERNS,
	WORKSPACE_ID_PREFIXES,
} from "./index.ts";

type Vector = {
	name: string;
	input: unknown;
	canonical: string;
	sha256: string;
};
const all: Vector[] = [...vectors.primitives, ...vectors.contracts];

describe("frozen vectors (fixtures/vectors.json)", () => {
	for (const v of all)
		test(v.name, () => {
			expect(canonicalEncode(v.input)).toBe(v.canonical);
			expect(sha256Hex(v.canonical)).toBe(v.sha256);
		});

	test("the sample graph still produces exactly the frozen contract vectors", () => {
		const g = sampleGraph();
		const byName = new Map(vectors.contracts.map((v) => [v.name, v]));
		const built: [string, unknown, string][] = [
			["proposal_snapshot", g.proposal.value, g.proposal.hash],
			["execution_binding", g.execution.value, g.execution.hash],
			["run_approval_binding", g.runBinding.value, g.runBinding.hash],
			["review_record", g.review, g.review_hash],
			["result_envelope", g.result.value, g.result.hash],
			["result_approval_binding", g.resultBinding.value, g.resultBinding.hash],
			["decision_payload_run_approve", g.runPayload, g.runPayloadHash],
			[
				"decision_payload_result_request_changes",
				g.resultPayload,
				g.resultPayloadHash,
			],
			[
				"challenge_binding",
				{ contract: "agentcity.challenge/v1", ...g.challenge },
				g.challengeHash,
			],
		];
		for (const [name, value, hash] of built) {
			const v = byName.get(name);
			expect(v).toBeDefined();
			expect(canonicalEncode(value)).toBe(v?.canonical as string);
			expect(hash).toBe(v?.sha256 as string);
		}
	});

	test("every contract vector input is valid against its contract schema", () => {
		const schemas: Record<string, z.ZodType> = {
			proposal_snapshot: ProposalSnapshot,
			execution_binding: ExecutionBinding,
			run_approval_binding: RunApprovalBinding,
			review_record: ReviewRecord,
			result_envelope: ResultEnvelope,
			result_approval_binding: ResultApprovalBinding,
			decision_payload_run_approve: DecisionPayload,
			decision_payload_result_request_changes: DecisionPayload,
			challenge_binding: ChallengeBinding,
		};
		for (const v of vectors.contracts) {
			const schema = schemas[v.name];
			expect(schema).toBeDefined();
			const parsed = (schema as z.ZodType).parse(v.input);
			// validate-only: parsing changes nothing that is hashed
			expect(canonicalEncode(parsed)).toBe(v.canonical);
		}
	});
});

describe("acyclic hash graph", () => {
	const g = sampleGraph();
	const contains = (value: unknown, hash: string) =>
		canonicalEncode(value).includes(hash);

	test("no structure contains its own hash", () => {
		expect(contains(g.proposal.value, g.proposal.hash)).toBe(false);
		expect(contains(g.execution.value, g.execution.hash)).toBe(false);
		expect(contains(g.runBinding.value, g.runBinding.hash)).toBe(false);
		expect(contains(g.review, g.review_hash)).toBe(false);
		expect(contains(g.result.value, g.result.hash)).toBe(false);
		expect(contains(g.resultBinding.value, g.resultBinding.hash)).toBe(false);
		expect(contains(g.runPayload, g.runPayloadHash)).toBe(false);
	});

	test("each layer binds the one below it", () => {
		expect(g.execution.value.proposal_hash).toBe(g.proposal.hash);
		expect(g.runBinding.value.proposal_hash).toBe(g.proposal.hash);
		expect(g.runBinding.value.execution_binding_hash).toBe(g.execution.hash);
		expect(g.result.value.proposal_hash).toBe(g.proposal.hash);
		expect(g.result.value.execution_binding_hash).toBe(g.execution.hash);
		expect(g.result.value.review.review_hash).toBe(g.review_hash);
		expect(g.result.value.run_decision_id).toBe(IDS.run_decision);
		expect(g.resultBinding.value.result_envelope_hash).toBe(g.result.hash);
		expect(g.runPayload.binding_hash).toBe(g.runBinding.hash);
		expect(g.challenge.binding_hash).toBe(g.runBinding.hash);
	});

	test("lower layers never reference higher ones (no receipts / decisions inside subjects)", () => {
		// the proposal and execution binding know nothing about approvals or decisions
		for (const s of [
			canonicalEncode(g.proposal.value),
			canonicalEncode(g.execution.value),
		]) {
			expect(s).not.toContain("wsa-");
			expect(s).not.toContain("wsd-");
			expect(s).not.toContain(g.runBinding.hash);
		}
		// the run binding does not name its decision; the envelope names only the Gate-1 decision
		expect(canonicalEncode(g.runBinding.value)).not.toContain("wsd-");
		expect(canonicalEncode(g.result.value)).not.toContain(IDS.result_decision);
		expect(canonicalEncode(g.result.value)).not.toContain(g.resultBinding.hash);
		expect(canonicalEncode(g.result.value)).not.toContain(g.runPayloadHash);
	});

	test("changing any bound field changes the hash", () => {
		const p = structuredClone(g.proposal.value);
		p.criteria = [...p.criteria, "One more"];
		expect(proposalHash(p)).not.toBe(g.proposal.hash);
		const b = structuredClone(g.runBinding.value);
		b.execution_binding_hash = sha256Hex("other");
		expect(approvalBindingHash(b)).not.toBe(g.runBinding.hash);
	});
});

describe("seal()", () => {
	test("refuses values the strict schema rejects (unknown keys, live mode)", () => {
		const g = sampleGraph();
		expect(() =>
			seal(ProposalSnapshot, { ...g.proposal.value, extra: 1 }),
		).toThrow();
		expect(() =>
			seal(ProposalSnapshot, { ...g.proposal.value, execution_mode: "live" }),
		).toThrow();
	});
	test("refuses a schema that would alter the hashed value", () => {
		const Trimming = z.strictObject({ s: z.string().trim() });
		expect(() => seal(Trimming, { s: " x " })).toThrow(/altered/);
		expect(seal(Trimming, { s: "x" }).hash).toBe(sha256Hex('{"s":"x"}'));
	});
	test("stored canonical text verifies against its hash", () => {
		const g = sampleGraph();
		expect(storedCanonicalMatches(g.result.canonical, g.result.hash)).toBe(
			true,
		);
		expect(
			storedCanonicalMatches(`${g.result.canonical} `, g.result.hash),
		).toBe(false);
	});
	test("create-task request hash is stable and content-sensitive", () => {
		const a = createTaskRequestHash({
			repo_id: "local/fixture",
			draft: emptyDraft(),
		});
		expect(a).toBe(
			createTaskRequestHash({ repo_id: "local/fixture", draft: emptyDraft() }),
		);
		expect(a).not.toBe(
			createTaskRequestHash({
				repo_id: "local/fixture",
				draft: { ...emptyDraft(), title: "x" },
			}),
		);
	});
});

describe("challenges", () => {
	const g = sampleGraph();
	const { token, expires_at, ...binding } = g.challenge;
	const now = new Date("2026-10-02T00:01:00.000Z");
	type Input = Parameters<typeof challengeValid>[0];
	const base: Input = {
		presented: token,
		stored_hash: g.challengeHash,
		status: "issued",
		expires_at,
		now,
		binding,
	};

	test("the matching token is valid", () => {
		expect(challengeValid(base)).toBe(true);
	});

	const invalid: [string, Partial<Input>][] = [
		["wrong token", { presented: `${token.slice(0, -1)}1` }],
		["malformed token", { presented: "short" }],
		["consumed", { status: "consumed" }],
		["never issued", { status: "none" }],
		["no stored hash", { stored_hash: null }],
		["expired (exactly at expiry)", { now: new Date(expires_at) }],
		["expired (later)", { now: new Date("2026-10-02T01:00:00.000Z") }],
		[
			"other request",
			{ binding: { ...binding, approval_request_id: IDS.result_request } },
		],
		["other kind", { binding: { ...binding, kind: "result" } }],
		[
			"other binding hash",
			{ binding: { ...binding, binding_hash: sha256Hex("x") } },
		],
		[
			"other request rev (stale tab)",
			{ binding: { ...binding, request_rev: 3 } },
		],
		[
			"other session generation (re-login)",
			{ binding: { ...binding, session_generation: 2 } },
		],
		[
			"other boot (hub restart)",
			{ binding: { ...binding, boot_id: newBootId() } },
		],
		["tampered expiry on the row", { expires_at: "2026-10-02T09:05:00.000Z" }],
	];
	for (const [name, patch] of invalid)
		test(`invalid: ${name}`, () => {
			expect(challengeValid({ ...base, ...patch })).toBe(false);
		});

	test("tokens are 43-char base64url, unique, and never the stored value", () => {
		const a = newToken256();
		const b = newToken256();
		expect(Token256.safeParse(a).success).toBe(true);
		expect(a).not.toBe(b);
		const h = challengeHash({ ...binding, token: a, expires_at });
		expect(h).not.toContain(a);
		expect(Token256.safeParse(FIXTURE_CHALLENGE_TOKEN).success).toBe(true);
	});

	test("expiry is TTL after now, in hashed timestamp form", () => {
		expect(challengeExpiry(new Date("2026-10-02T00:00:00.000Z"))).toBe(
			new Date(
				Date.parse("2026-10-02T00:00:00.000Z") + CHALLENGE_TTL_MS,
			).toISOString(),
		);
		expect(CHALLENGE_TTL_MS).toBeLessThanOrEqual(300_000);
	});
});

describe("id minting", () => {
	test("workspace ids match their strict patterns", () => {
		for (const p of WORKSPACE_ID_PREFIXES)
			expect(WORKSPACE_ID_PATTERNS[p].test(newWorkspaceId(p))).toBe(true);
		expect(BootId.safeParse(newBootId()).success).toBe(true);
	});
});
