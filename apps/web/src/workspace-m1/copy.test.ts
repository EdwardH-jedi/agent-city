// Copy audit (role 07, BRW-J-17): no merge / push / deploy vocabulary in any label, nor in any
// string the fixture can put on screen (stage details, reasons, artifact text, error messages).
import { describe, expect, test } from "bun:test";
import { criteriaFromText, emptyDraft } from "@agent-city/schema/workspace-m1";
import { SCENARIOS } from "./draft-form.ts";
import { createFixtureTransport } from "./fixture-transport.ts";
import type { FixtureEvidence } from "./fixture-world.ts";
import { allStaticCopy } from "./labels.ts";
import type { TransportResult } from "./transport.ts";

const BANNED =
	/\b(merg(e|ed|es|ing)|push(ed|es|ing)?|deploy(ed|s|ing|ment)?)\b/i;

function strings(v: unknown, out: string[] = []): string[] {
	if (typeof v === "string") out.push(v);
	else if (Array.isArray(v)) for (const x of v) strings(x, out);
	else if (v && typeof v === "object")
		for (const x of Object.values(v)) strings(x, out);
	return out;
}

const collect = (r: TransportResult<unknown>, out: string[]) =>
	strings(r.ok ? r.data : r.kind === "http" ? r.error : r.message, out);

describe("copy audit", () => {
	test("every static label is free of merge/push/deploy wording", () => {
		const bad = allStaticCopy().filter((s) => BANNED.test(s));
		expect(bad).toEqual([]);
	});

	test("every fixture string reachable in a journey is free of it too", async () => {
		const out: string[] = [];
		const tx = createFixtureTransport();
		let k = 0;
		const evidence: FixtureEvidence[] = [
			"verified",
			"missing",
			"withheld",
			"corrupt",
			"truncated_log",
		];
		for (const [i, scenario] of SCENARIOS.entries()) {
			for (const max_repairs of [0, 1] as const) {
				const created = await tx.createTask({
					idempotency_key: `copy-audit-${++k}`,
					repo_id: "local/fixture",
					draft: {
						...emptyDraft(),
						title: `Audit ${scenario}`,
						objective: "Copy audit journey.",
						criteria: criteriaFromText("One, two\nThree"),
						criterion_checks: [
							{ criterion: "One, two", checks: ["unit"] },
							{ criterion: "Three", checks: ["unit", "lint"] },
						],
						scope: { allowed: ["."], protected: [] },
						simulation_scenario: scenario,
						repair_policy: { max_repairs },
					},
				});
				if (!created.ok) throw new Error("create");
				const id = created.data.task.id;
				const pub = await tx.publishProposal(id, {
					expected_rev: created.data.task.rev,
				});
				if (!pub.ok) throw new Error("publish");
				const req = pub.data.approval_requests[0];
				if (!req) throw new Error("request");
				const ch = await tx.issueChallenge(req.id, {
					kind: "run",
					binding_hash: req.binding_hash,
					expected_request_rev: req.rev,
				});
				if (!ch.ok) throw new Error("challenge");
				collect(
					await tx.decide(
						req.id,
						JSON.stringify({
							idempotency_key: `copy-audit-d-${++k}`,
							kind: "run",
							action: "approve",
							expected_request_rev: ch.data.request_rev,
							binding_hash: req.binding_hash,
							confirmation_text: "Edward",
							reason: null,
							challenge: ch.data.challenge,
						}),
					),
					out,
				);
				tx.controls.advance(id);
				if (scenario === "impl_hangs") {
					const d = await tx.getTask(id);
					if (d.ok)
						collect(
							await tx.cancel(id, { expected_rev: d.data.task.rev }),
							out,
						);
					tx.controls.confirmCancel(id);
				}
				tx.controls.runToEnd(id, evidence[i % evidence.length]);
				const detail = await tx.getTask(id);
				collect(detail, out);
				if (detail.ok)
					for (const a of detail.data.artifacts)
						collect(await tx.getArtifact(id, a.artifact_id), out);
				collect(await tx.cancel(id, { expected_rev: 1 }), out);
			}
		}
		collect(await tx.getSnapshot(), out);
		expect(out.length).toBeGreaterThan(200);
		expect(out.filter((s) => BANNED.test(s))).toEqual([]);
	});
});
