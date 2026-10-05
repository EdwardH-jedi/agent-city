// Pure scheduler: concurrency, capacity, ordering, exclusions, bounds, no mutation.
import { describe, expect, test } from "bun:test";
import type { SupportJob } from "./job.ts";
import {
	DEFAULT_SUPPORT_CONCURRENCY,
	MAX_SUPPORT_SCHEDULER_INPUT,
	SUPPORT_SCHEDULE_HARD_CAP,
	type SupportSchedulerOptions,
	selectSupportJobs,
} from "./scheduler.ts";
import { completeSupportJob, failSupportJob } from "./state.ts";
import {
	cancelled,
	cancelRequested,
	queued,
	running,
	seededShuffle,
} from "./testkit.ts";

const ids = (jobs: readonly SupportJob[]) => jobs.map((j) => j.id);
const queuedMany = (n: number, prefix = "q") =>
	Array.from({ length: n }, (_, i) =>
		queued({ id: `${prefix}${String(i).padStart(3, "0")}`, seq: i }),
	);

describe("6. concurrency = 4 by default", () => {
	test("default constant is 4", () => {
		expect(DEFAULT_SUPPORT_CONCURRENCY).toBe(4);
	});

	test("10 queued → 4 launched, oldest first", () => {
		const s = selectSupportJobs(queuedMany(10));
		expect(ids(s.launch)).toEqual(["q000", "q001", "q002", "q003"]);
		expect(s.running).toBe(0);
		expect(s.available_slots).toBe(4);
	});

	test("fewer queued than slots → all launched", () => {
		expect(selectSupportJobs(queuedMany(2)).launch.length).toBe(2);
	});

	test("explicit concurrency is honoured", () => {
		expect(
			selectSupportJobs(queuedMany(10), { concurrency: 1 }).launch.length,
		).toBe(1);
		expect(
			selectSupportJobs(queuedMany(10), { concurrency: 7 }).launch.length,
		).toBe(7);
	});

	test("empty input → nothing", () => {
		expect(selectSupportJobs([])).toEqual({
			launch: [],
			running: 0,
			available_slots: 4,
		});
	});
});

describe("7. running jobs consume capacity", () => {
	test("3 running + 5 queued → 1 launched", () => {
		const jobs = [
			running({ id: "r1" }),
			running({ id: "r2" }),
			running({ id: "r3" }),
			...queuedMany(5),
		];
		const s = selectSupportJobs(jobs);
		expect(s.running).toBe(3);
		expect(s.available_slots).toBe(1);
		expect(ids(s.launch)).toEqual(["q000"]);
	});

	test("cancel-requested RUNNING jobs still hold a slot", () => {
		const jobs = [
			cancelRequested({ id: "r1" }),
			running({ id: "r2" }),
			running({ id: "r3" }),
			running({ id: "r4" }),
			...queuedMany(3),
		];
		const s = selectSupportJobs(jobs);
		expect(s.running).toBe(4);
		expect(s.launch).toEqual([]);
	});

	test("more running than concurrency → zero slots, never negative", () => {
		const jobs = [
			...Array.from({ length: 6 }, (_, i) => running({ id: `r${i}` })),
			...queuedMany(3),
		];
		const s = selectSupportJobs(jobs);
		expect(s.running).toBe(6);
		expect(s.available_slots).toBe(0);
		expect(s.launch).toEqual([]);
	});

	test("terminal jobs do not consume capacity", () => {
		const r = running({ id: "done" });
		const c = completeSupportJob(r, {
			artifact_id: "done.artifact",
			artifact_kind: r.kind,
			text_chars: 1,
		});
		const f = failSupportJob(running({ id: "bad" }), {
			classification: "EXECUTOR_ERROR",
			detail: "x",
		});
		if (!c.ok || !f.ok) throw new Error("fixture");
		const s = selectSupportJobs([c.job, f.job, ...queuedMany(5)]);
		expect(s.running).toBe(0);
		expect(s.launch.length).toBe(4);
	});
});

describe("8. priority, then stable tie-break", () => {
	const jobs = [
		queued({ id: "low-old", seq: 1, priority: 10 }),
		queued({ id: "high-new", seq: 9, priority: 90 }),
		queued({ id: "high-old", seq: 2, priority: 90 }),
		queued({ id: "mid-b", seq: 5, priority: 50 }),
		queued({ id: "mid-a", seq: 5, priority: 50 }),
		queued({ id: "mid-c", seq: 3, priority: 50 }),
		queued({ id: "top", seq: 100, priority: 100 }),
	];
	const expected = [
		"top",
		"high-old",
		"high-new",
		"mid-c",
		"mid-a",
		"mid-b",
		"low-old",
	];

	test("priority desc → created_seq asc → id asc", () => {
		expect(ids(selectSupportJobs(jobs, { concurrency: 16 }).launch)).toEqual(
			expected,
		);
	});

	test.each([1, 2, 3, 42, 1234, 99999, 0xdeadbeef])(
		"shuffled input (seed %d) → identical output",
		(seed) => {
			const shuffled = seededShuffle(jobs, seed);
			expect(
				ids(selectSupportJobs(shuffled, { concurrency: 16 }).launch),
			).toEqual(expected);
			expect(ids(selectSupportJobs(shuffled).launch)).toEqual(
				expected.slice(0, 4),
			);
		},
	);

	test("id tie-break uses code units, not locale", () => {
		const s = selectSupportJobs([
			queued({ id: "b", seq: 0 }),
			queued({ id: "B", seq: 0 }),
			queued({ id: "a", seq: 0 }),
			queued({ id: "A", seq: 0 }),
		]);
		expect(ids(s.launch)).toEqual(["A", "B", "a", "b"]);
	});
});

describe("9. cancelled / disabled jobs never launch", () => {
	test("only eligible QUEUED jobs are chosen", () => {
		const jobs = [
			cancelled({ id: "c1", priority: 100 }),
			cancelled({ id: "c2", priority: 100 }),
			queued({ id: "d1", priority: 100, disabled: true }),
			cancelRequested({ id: "cr" }),
			queued({ id: "ok1", priority: 1, seq: 1 }),
			queued({ id: "ok2", priority: 1, seq: 2 }),
		];
		const s = selectSupportJobs(jobs, { concurrency: 16 });
		expect(ids(s.launch)).toEqual(["ok1", "ok2"]);
	});

	test("only cancelled / disabled jobs → nothing launches", () => {
		const jobs = [
			cancelled({ id: "c1" }),
			queued({ id: "d1", disabled: true }),
		];
		expect(selectSupportJobs(jobs).launch).toEqual([]);
	});
});

describe("10. bounded scheduling result", () => {
	test("result never exceeds free slots nor the hard cap", () => {
		const jobs = queuedMany(200);
		for (let c = 1; c <= 16; c++) {
			const s = selectSupportJobs(jobs, { concurrency: c });
			expect(s.launch.length).toBe(c);
			expect(s.launch.length).toBeLessThanOrEqual(SUPPORT_SCHEDULE_HARD_CAP);
		}
	});

	test("result is frozen", () => {
		const s = selectSupportJobs(queuedMany(5));
		expect(Object.isFrozen(s)).toBe(true);
		expect(Object.isFrozen(s.launch)).toBe(true);
	});

	test("input array is not mutated (order and contents)", () => {
		const jobs = seededShuffle([...queuedMany(20), running({ id: "r1" })], 7);
		const before = structuredClone(jobs);
		const order = ids(jobs);
		selectSupportJobs(jobs, { concurrency: 8 });
		expect(jobs).toEqual(before);
		expect(ids(jobs)).toEqual(order);
	});

	test("returns the caller's job objects, not copies", () => {
		const jobs = queuedMany(2);
		const s = selectSupportJobs(jobs);
		expect(s.launch[0]).toBe(jobs[0] as SupportJob);
	});

	test.each([0, 17, 2.5, -1, Number.NaN, "4", null])(
		"concurrency %p is rejected",
		(concurrency) => {
			expect(() =>
				selectSupportJobs(queuedMany(1), {
					concurrency,
				} as unknown as SupportSchedulerOptions),
			).toThrow();
		},
	);

	test("unknown option keys are rejected", () => {
		expect(() =>
			selectSupportJobs(queuedMany(1), {
				fetch_more: true,
			} as unknown as SupportSchedulerOptions),
		).toThrow();
	});

	test("oversized snapshot and duplicate ids are rejected", () => {
		const one = queued({ id: "dup" });
		const big = Array.from(
			{ length: MAX_SUPPORT_SCHEDULER_INPUT + 1 },
			() => one,
		);
		expect(() => selectSupportJobs(big)).toThrow(RangeError);
		expect(() => selectSupportJobs([one, one])).toThrow(RangeError);
	});
});

describe("optional per-repo fairness (max_per_repo)", () => {
	test("caps launches per repo; the slot goes to the next repo", () => {
		const jobs = [
			queued({ id: "a1", repo_id: "acme/widgets", seq: 1 }),
			queued({ id: "a2", repo_id: "acme/widgets", seq: 2 }),
			queued({ id: "a3", repo_id: "acme/widgets", seq: 3 }),
			queued({ id: "b1", repo_id: "local/scratch", seq: 4 }),
		];
		expect(ids(selectSupportJobs(jobs).launch)).toEqual([
			"a1",
			"a2",
			"a3",
			"b1",
		]);
		expect(ids(selectSupportJobs(jobs, { max_per_repo: 1 }).launch)).toEqual([
			"a1",
			"b1",
		]);
	});

	test("running jobs count against the repo cap, case-insensitively", () => {
		const jobs = [
			running({ id: "r", repo_id: "Acme/Widgets" }),
			queued({ id: "a1", repo_id: "acme/widgets", seq: 1 }),
			queued({ id: "b1", repo_id: "local/scratch", seq: 2 }),
		];
		expect(ids(selectSupportJobs(jobs, { max_per_repo: 1 }).launch)).toEqual([
			"b1",
		]);
	});

	test("max_per_repo bounds are validated", () => {
		for (const max_per_repo of [0, 17, 1.5])
			expect(() =>
				selectSupportJobs(queuedMany(1), { max_per_repo }),
			).toThrow();
	});
});
