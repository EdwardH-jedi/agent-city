// Accepted-result validity freshness under the default batch (CONTRACT_V1_2.md §C "Detection timing";
// follow-up P2 of the independent re-review). The sweep re-checks at most 20 `valid|unknown` rows per
// run, oldest check first, so N eligible results need about ceil(N/20) sweeps; the snapshot never
// starts a check; a task-detail read whose last check is older than 5 s does. Here 22 accepted
// results, the two most recently checked (#21, #22) damaged before the first sweep: sweep 1 checks
// the 20 oldest and finds nothing; #21 is caught by a detail read, #22 by the next sweep.
// Real engine, fake adapters, disposable fixture repo.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
	approved,
	artifactFile,
	type BridgeEnv,
	decide,
	makeBridgeEnv,
	resultRequests,
	tracker,
} from "./test-support.ts";

const t = tracker();
afterEach(() => t.cleanup());

const DEFAULT_BATCH = 20;

async function acceptedTask(env: BridgeEnv) {
	const v = await env.ctx();
	const ids = await approved(env, v);
	await env.drain();
	const [r] = resultRequests(env, ids.taskId);
	if (r?.status !== "pending" || !r.run_id)
		throw new Error(`no pending Gate 2: ${r?.status}`);
	const res = await decide(env, v, r.id);
	if (!res.ok) throw new Error(`accept failed: ${JSON.stringify(res.body)}`);
	return {
		taskId: ids.taskId,
		runId: r.run_id,
		decisionId: res.body.receipt.decision_id,
	};
}

describe("accepted-result validity: batch of 20 per sweep, oldest check first (default)", () => {
	test("22 accepted, #21 and #22 damaged: sweep 1 checks 20 and finds nothing; the snapshot never checks; a detail read catches #21; sweep 2 catches #22", async () => {
		const env = t.track(makeBridgeEnv()); // default maxAcceptedChecksPerSweep (20)
		const accepted: Awaited<ReturnType<typeof acceptedTask>>[] = [];
		for (let i = 0; i < DEFAULT_BATCH + 2; i++) {
			accepted.push(await acceptedTask(env));
			env.tick();
		}
		const validity = (i: number) =>
			env.store.getAcceptanceValidity(accepted[i]?.decisionId as string);
		const checkedAt = accepted.map((_, i) => validity(i)?.checked_at);
		// each acceptance starts `valid` at its decision time: #22 is the most recently checked
		for (let i = 1; i < accepted.length; i++)
			expect((checkedAt[i] as string) > (checkedAt[i - 1] as string)).toBe(
				true,
			);
		const [n21, n22] = [DEFAULT_BATCH, DEFAULT_BATCH + 1];
		for (const i of [n21, n22])
			writeFileSync(
				artifactFile(env, accepted[i]?.runId as string, "diff.patch"),
				"damaged after acceptance\n",
			);

		env.tick(30_000);
		const s1 = await env.bridge.sweep();
		expect([s1.accepted_checked, s1.accepted_invalid]).toEqual([
			DEFAULT_BATCH,
			0,
		]);
		for (let i = 0; i < DEFAULT_BATCH; i++)
			expect(
				(validity(i)?.checked_at as string) > (checkedAt[i] as string),
			).toBe(true);
		// the damaged two were not reached: still `valid` from their decision-time check
		for (const i of [n21, n22])
			expect(validity(i)).toMatchObject({
				status: "valid",
				checked_at: checkedAt[i],
			});

		// a snapshot (list) read serves the stored rows and never starts a check
		const snap = env.services.reads.snapshot(env.now());
		if (!snap.ok) throw new Error("snapshot failed");
		for (const i of [n21, n22]) {
			const item = snap.body.tasks.find(
				(x) => x.task.id === accepted[i]?.taskId,
			);
			expect(item?.acceptance_validity?.status).toBe("valid");
			expect(validity(i)?.checked_at).toBe(checkedAt[i]);
		}

		// #21: a task-detail read (last check older than 5 s) runs and awaits the full check
		const d21 = await env.services.reads.taskDetailChecked(
			accepted[n21]?.taskId as string,
		);
		expect(d21.ok && d21.body.acceptance_validity).toMatchObject({
			status: "invalid",
			reason: "source_evidence_changed",
		});
		expect(validity(n21)?.status).toBe("invalid");
		expect(validity(n22)?.status).toBe("valid"); // nobody read #22 in detail

		// #22: the next sweep — it is now the oldest check among the `valid|unknown` rows
		env.tick(30_000);
		const s2 = await env.bridge.sweep();
		expect([s2.accepted_checked, s2.accepted_invalid]).toEqual([
			DEFAULT_BATCH,
			1,
		]);
		expect(validity(n22)).toMatchObject({
			status: "invalid",
			reason: "source_evidence_changed",
		});
		// sticky: #21 / #22 are never selected again; the 20 eligible rows fill the next batch
		env.tick(30_000);
		const s3 = await env.bridge.sweep();
		expect([s3.accepted_checked, s3.accepted_invalid]).toEqual([
			DEFAULT_BATCH,
			0,
		]);
		for (const i of [n21, n22]) expect(validity(i)?.status).toBe("invalid");
	}, 120_000);
});
