// biome-ignore-all lint/suspicious/noExplicitAny: adversarial tests inspect raw, untyped HTTP bodies and SQLite rows on purpose
// ADV-HASH — canonical encoding and the acyclic hash graph, recomputed independently from what the
// integrated hub actually stored after a full Gate 1 → engine → Gate 2 journey.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalEncode } from "@agent-city/schema/workspace-m1/hash";
import {
	assertIsolation,
	composedHub,
	liveServers,
	requestRow,
	teardown,
	toGate2,
} from "./harness.ts";

assertIsolation();
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let stored: { proposal: any; run: any; result: any; decisions: any[] };
beforeAll(async () => {
	const H = composedHub();
	const c = await H.signIn();
	const g = await toGate2(c, H.fx);
	stored = {
		proposal: H.db
			.query("SELECT * FROM managed_proposals WHERE workspace_task_id = ?")
			.get(g.taskId),
		run: requestRow(H.db, g.req.id),
		result: requestRow(H.db, g.g2.id),
		decisions: H.db.query("SELECT * FROM managed_decisions").all() as any[],
	};
	await teardown();
}, 60_000);
afterAll(async () => {
	await teardown();
	expect(liveServers).toBe(0);
});

describe("ADV-HASH", () => {
	test("ADV-HASH-01/05/06 every stored hash recomputes from its stored canonical text (independent sha256)", () => {
		const p = stored.proposal;
		expect(sha(p.snapshot)).toBe(p.proposal_hash);
		expect(canonicalEncode(JSON.parse(p.snapshot))).toBe(p.snapshot);
		for (const r of [stored.run, stored.result]) {
			expect(sha(r.execution_binding)).toBe(r.execution_binding_hash);
			expect(sha(r.binding)).toBe(r.binding_hash);
			expect(canonicalEncode(JSON.parse(r.binding))).toBe(r.binding);
		}
		expect(sha(stored.result.result_envelope)).toBe(
			stored.result.result_envelope_hash,
		);
		// the graph links: run binding → execution binding → proposal; result binding → envelope
		const rb = JSON.parse(stored.run.binding);
		expect([rb.proposal_hash, rb.execution_binding_hash]).toEqual([
			p.proposal_hash,
			stored.run.execution_binding_hash,
		]);
		const xb = JSON.parse(stored.run.execution_binding);
		expect(xb.proposal_hash).toBe(p.proposal_hash);
		const resb = JSON.parse(stored.result.binding);
		expect(resb.result_envelope_hash).toBe(stored.result.result_envelope_hash);
		const env = JSON.parse(stored.result.result_envelope);
		expect([env.proposal_hash, env.execution_binding_hash]).toEqual([
			p.proposal_hash,
			stored.run.execution_binding_hash,
		]);
		const runDecision = stored.decisions.find(
			(d) => d.approval_request_id === stored.run.id,
		);
		expect(env.run_decision_id).toBe(runDecision.id);
	});

	test("ADV-HASH-02 key order never matters; every bound proposal field changes the hash", () => {
		const snap = JSON.parse(stored.proposal.snapshot);
		const reversed = Object.fromEntries(Object.entries(snap).reverse());
		expect(sha(canonicalEncode(reversed))).toBe(stored.proposal.proposal_hash);
		const mutate: Record<string, (s: any) => void> = {
			repo_id: (s) => {
				s.repo_id = "local/other";
			},
			base_sha: (s) => {
				s.base_sha = "0".repeat(40);
			},
			objective: (s) => {
				s.objective += ".";
			},
			criteria: (s) => {
				s.criteria = [...s.criteria, "extra"];
			},
			scope: (s) => {
				s.scope = { ...s.scope, allowed: ["src"] };
			},
			execution_mode: (s) => {
				s.execution_mode = "live";
			},
			simulation_scenario: (s) => {
				s.simulation_scenario = "reject_always";
			},
			provider_profiles: (s) => {
				s.provider_profiles = { ...s.provider_profiles, extra: 1 };
			},
			verification_plan: (s) => {
				s.verification_plan = { ...s.verification_plan, required_checks: [] };
			},
			context_policy: (s) => {
				s.context_policy = { ...s.context_policy, refs: ["x"] };
			},
			budgets: (s) => {
				s.budgets = { ...s.budgets, max_attempts: 9 };
			},
			repair_policy: (s) => {
				s.repair_policy = { max_repairs: 1 };
			},
		};
		for (const [field, fn] of Object.entries(mutate)) {
			expect(field in snap).toBe(true);
			const copy = structuredClone(snap);
			fn(copy);
			expect([
				field,
				sha(canonicalEncode(copy)) === stored.proposal.proposal_hash,
			]).toEqual([field, false]);
		}
	});

	test("ADV-HASH-03 canonical encoder rejects ambiguous values and does not normalize Unicode", () => {
		for (const bad of [
			{ a: undefined },
			{ a: Number.NaN },
			{ a: Number.POSITIVE_INFINITY },
			{ a: 1.5 },
			{ a: 2 ** 53 },
			{ a: "\uD800" },
			{ a: new Date(0) },
			{ a: 10n },
		])
			expect(() => canonicalEncode(bad)).toThrow();
		expect(canonicalEncode({ a: -0 })).toBe('{"a":0}');
		expect(canonicalEncode({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
		expect(canonicalEncode({ s: "é" })).not.toBe(canonicalEncode({ s: "é" }));
		let deep: any = 1;
		for (let i = 0; i < 70; i++) deep = [deep];
		expect(() => canonicalEncode(deep)).toThrow();
	});

	test("ADV-HASH-04 no stored structure contains its own final hash", () => {
		expect(stored.proposal.snapshot).not.toContain(
			stored.proposal.proposal_hash,
		);
		for (const r of [stored.run, stored.result]) {
			expect(r.binding).not.toContain(r.binding_hash);
			expect(r.execution_binding).not.toContain(r.execution_binding_hash);
		}
		expect(stored.result.result_envelope).not.toContain(
			stored.result.result_envelope_hash,
		);
		// receipts are never hashed into subjects
		for (const d of stored.decisions) {
			expect(stored.result.result_envelope).not.toContain(d.payload_hash);
		}
	});

	test("ADV-HASH-06 dropping or altering any envelope element changes the bound hash", () => {
		const env = JSON.parse(stored.result.result_envelope);
		const variants: [string, (e: any) => void][] = [
			[
				"artifact dropped",
				(e) => {
					e.artifacts = e.artifacts.slice(1);
				},
			],
			[
				"artifact sha",
				(e) => {
					e.artifacts[0].sha256 = "0".repeat(64);
				},
			],
			[
				"artifact status",
				(e) => {
					e.artifacts[0].status = "truncated";
				},
			],
			[
				"review hash",
				(e) => {
					e.review.review_hash = "0".repeat(64);
				},
			],
			[
				"verification",
				(e) => {
					e.verification = [];
				},
			],
			[
				"run decision",
				(e) => {
					e.run_decision_id = "wsd-00000000-0000-4000-8000-000000000000";
				},
			],
			[
				"attempt",
				(e) => {
					e.attempt_no = 2;
				},
			],
		];
		for (const [name, fn] of variants) {
			const copy = structuredClone(env);
			fn(copy);
			expect([
				name,
				sha(canonicalEncode(copy)) === stored.result.result_envelope_hash,
			]).toEqual([name, false]);
		}
	});

	test("ADV-HASH-07 structured encoding: field-boundary shifts never collide", () => {
		expect(sha(canonicalEncode({ a: "ab", b: "c" }))).not.toBe(
			sha(canonicalEncode({ a: "a", b: "bc" })),
		);
		expect(sha(canonicalEncode(["a,b"]))).not.toBe(
			sha(canonicalEncode(["a", "b"])),
		);
	});
});
