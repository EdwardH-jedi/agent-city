// Support state machine: exhaustive from×to table, managed states rejected, lifecycle invariants.
import { describe, expect, test } from "bun:test";
import {
	SUPPORT_JOB_STATUSES,
	type SupportJob,
	type SupportJobStatus,
} from "./job.ts";
import {
	assignSupportProfile,
	canSupportTransition,
	completeSupportJob,
	failSupportJob,
	requestSupportCancel,
	startSupportJob,
	transitionSupportJob,
} from "./state.ts";
import { cancelled, cancelRequested, queued, running } from "./testkit.ts";

const meta = (job: SupportJob) => ({
	artifact_id: `${job.id}.artifact`,
	artifact_kind: job.kind,
	text_chars: 10,
});
const failure = { classification: "INVALID_OUTPUT", detail: "x" } as const;

// Literal expected matrix — editing the transition table without editing this fails loudly.
const EXPECTED: Record<SupportJobStatus, Record<SupportJobStatus, boolean>> = {
	QUEUED: {
		QUEUED: false,
		RUNNING: true,
		COMPLETED: false,
		FAILED: false,
		CANCELLED: true,
	},
	RUNNING: {
		QUEUED: false,
		RUNNING: false,
		COMPLETED: true,
		FAILED: true,
		CANCELLED: true,
	},
	COMPLETED: {
		QUEUED: false,
		RUNNING: false,
		COMPLETED: false,
		FAILED: false,
		CANCELLED: false,
	},
	FAILED: {
		QUEUED: false,
		RUNNING: false,
		COMPLETED: false,
		FAILED: false,
		CANCELLED: false,
	},
	CANCELLED: {
		QUEUED: false,
		RUNNING: false,
		COMPLETED: false,
		FAILED: false,
		CANCELLED: false,
	},
};

/** A job in `status`, built only through legal transitions. */
function jobIn(status: SupportJobStatus): SupportJob {
	const q = queued({ id: `sj-${status.toLowerCase()}` });
	const r = startSupportJob(q);
	if (!r.ok) throw new Error(r.error);
	const settle = (x: ReturnType<typeof startSupportJob>): SupportJob => {
		if (!x.ok) throw new Error(x.error);
		return x.job;
	};
	switch (status) {
		case "QUEUED":
			return q;
		case "RUNNING":
			return r.job;
		case "COMPLETED":
			return settle(completeSupportJob(r.job, meta(r.job)));
		case "FAILED":
			return settle(failSupportJob(r.job, failure));
		case "CANCELLED":
			return settle(transitionSupportJob(r.job, "CANCELLED"));
	}
}

const pairs = SUPPORT_JOB_STATUSES.flatMap((from) =>
	SUPPORT_JOB_STATUSES.map((to) => [from, to] as const),
);

describe("4/5. exhaustive transition table (5×5)", () => {
	test("canSupportTransition matches the literal matrix", () => {
		expect(pairs.length).toBe(25);
		for (const [from, to] of pairs)
			expect([from, to, canSupportTransition(from, to)]).toEqual([
				from,
				to,
				EXPECTED[from][to],
			]);
	});

	test.each(pairs)("%s → %s via transitionSupportJob", (from, to) => {
		const job = jobIn(from);
		const fields =
			to === "COMPLETED"
				? { result: meta(job) }
				: to === "FAILED"
					? { failure }
					: {};
		const r = transitionSupportJob(job, to, fields);
		if (EXPECTED[from][to]) {
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.job.status).toBe(to);
		} else {
			expect(r).toEqual({ ok: false, error: "illegal_transition" });
		}
		// The argument is never mutated.
		expect(job.status).toBe(from);
	});
});

describe("4. legal lifecycle", () => {
	test("QUEUED → RUNNING → COMPLETED records result metadata", () => {
		const s = startSupportJob(queued({ id: "a" }));
		expect(s.ok && s.job.status).toBe("RUNNING");
		if (!s.ok) return;
		const c = completeSupportJob(s.job, meta(s.job));
		expect(c.ok && c.job.status).toBe("COMPLETED");
		expect(c.ok && c.job.result).toEqual(meta(s.job));
		expect(c.ok && Object.isFrozen(c.job)).toBe(true);
	});

	test("RUNNING → FAILED records the classification", () => {
		const f = failSupportJob(running({ id: "b" }), failure);
		expect(f.ok && f.job.status).toBe("FAILED");
		expect(f.ok && f.job.failure).toEqual(failure);
	});

	test("cancel: QUEUED → CANCELLED at once; CANCELLED stays (idempotent)", () => {
		const c = requestSupportCancel(queued({ id: "c" }));
		expect(c.ok && c.job.status).toBe("CANCELLED");
		if (!c.ok) return;
		const again = requestSupportCancel(c.job);
		expect(again.ok && again.job).toEqual(c.job);
	});

	test("cancel while RUNNING: intent recorded, settle ends CANCELLED", () => {
		const job = cancelRequested({ id: "d" });
		expect(job.status).toBe("RUNNING");
		expect(job.cancel_requested).toBe(true);
		const done = completeSupportJob(job, meta(job));
		expect(done.ok && done.job.status).toBe("CANCELLED");
		expect(done.ok && done.job.result).toBeNull();
		const failed = failSupportJob(job, failure);
		expect(failed.ok && failed.job.status).toBe("CANCELLED");
		expect(failed.ok && failed.job.failure).toBeNull();
	});

	test("profile can be assigned only while QUEUED, and only a valid id", () => {
		const a = assignSupportProfile(queued({ id: "e" }), "fast-tier-1");
		expect(a.ok && a.job.profile_id).toBe("fast-tier-1");
		expect(assignSupportProfile(queued({ id: "e" }), "Bad Id!")).toEqual({
			ok: false,
			error: "invalid_profile",
		});
		expect(assignSupportProfile(running({ id: "e" }), "fast-tier-1")).toEqual({
			ok: false,
			error: "illegal_transition",
		});
	});
});

describe("5. illegal transitions fail", () => {
	const managedStates = [
		"queued",
		"running",
		"draft",
		"executing",
		"verifying",
		"reviewing",
		"repairing",
		"human_ready",
		"blocked",
		"interrupted",
		"failed",
		"cancelled",
		"completed",
	];

	test.each(managedStates)(
		"managed / lower-case state '%s' is unknown",
		(s) => {
			expect(canSupportTransition("QUEUED", s)).toBe(false);
			expect(canSupportTransition(s, "RUNNING")).toBe(false);
			expect(transitionSupportJob(queued({ id: "m" }), s)).toEqual({
				ok: false,
				error: "unknown_state",
			});
			expect(transitionSupportJob(running({ id: "m" }), s)).toEqual({
				ok: false,
				error: "unknown_state",
			});
		},
	);

	test.each([[undefined], [null], [1], [{}], [["RUNNING"]]] as const)(
		"non-string target %p is unknown",
		(to) => {
			expect(transitionSupportJob(queued({ id: "n" }), to)).toEqual({
				ok: false,
				error: "unknown_state",
			});
		},
	);

	test("COMPLETED without result / FAILED without failure violate invariants", () => {
		expect(transitionSupportJob(running({ id: "o" }), "COMPLETED")).toEqual({
			ok: false,
			error: "invariant",
		});
		expect(transitionSupportJob(running({ id: "o" }), "FAILED")).toEqual({
			ok: false,
			error: "invariant",
		});
	});

	test("result of another kind is rejected", () => {
		const job = running({ id: "p", kind: "HANDOFF" });
		const r = completeSupportJob(job, {
			...meta(job),
			artifact_kind: "PR_DRAFT",
		});
		expect(r).toEqual({ ok: false, error: "invariant" });
	});

	test("a disabled job cannot start", () => {
		expect(startSupportJob(queued({ id: "q", disabled: true }))).toEqual({
			ok: false,
			error: "disabled",
		});
	});

	test("terminal jobs cannot be cancelled or restarted", () => {
		for (const status of ["COMPLETED", "FAILED"] as const) {
			const job = jobIn(status);
			expect(requestSupportCancel(job)).toEqual({
				ok: false,
				error: "illegal_transition",
			});
			expect(startSupportJob(job)).toEqual({
				ok: false,
				error: "illegal_transition",
			});
		}
		expect(startSupportJob(cancelled({ id: "r" }))).toEqual({
			ok: false,
			error: "illegal_transition",
		});
	});

	test("a tampered job object is refused", () => {
		const job = {
			...queued({ id: "s" }),
			status: "executing",
		} as unknown as SupportJob;
		expect(startSupportJob(job)).toEqual({ ok: false, error: "invalid_job" });
	});
});

/** `value` with an enumerable getter `key` that throws. */
const withThrowingGetter = <T extends object>(value: T, key: string): T => {
	const copy = { ...value };
	Object.defineProperty(copy, key, {
		enumerable: true,
		get() {
			throw new Error("unreadable");
		},
	});
	return copy;
};
/** A value whose every trap throws. */
const hostile = (): never =>
	new Proxy(
		{},
		{
			get() {
				throw new Error("trap");
			},
			has() {
				throw new Error("trap");
			},
			ownKeys() {
				throw new Error("trap");
			},
			getOwnPropertyDescriptor() {
				throw new Error("trap");
			},
			getPrototypeOf() {
				throw new Error("trap");
			},
		},
	) as never;

describe("MF-P2-02 — unreadable jobs and values never throw out of a transition", () => {
	test("every lifecycle helper returns invalid_job for an unreadable job", () => {
		const done = meta(running({ id: "s-0" }));
		for (const bad of [
			withThrowingGetter(running({ id: "s-1" }), "status"),
			hostile() as SupportJob,
		]) {
			for (const r of [
				transitionSupportJob(bad, "CANCELLED"),
				startSupportJob(bad),
				requestSupportCancel(bad),
				completeSupportJob(bad, done),
				failSupportJob(bad, failure),
				assignSupportProfile(bad, "clerk-fast"),
			])
				expect(r).toEqual({ ok: false, error: "invalid_job" });
		}
	});

	test("an unreadable result or failure value is an invariant failure", () => {
		expect(completeSupportJob(running({ id: "s-2" }), hostile())).toEqual({
			ok: false,
			error: "invariant",
		});
		expect(failSupportJob(running({ id: "s-3" }), hostile())).toEqual({
			ok: false,
			error: "invariant",
		});
	});

	test("an unreadable target state or profile id is refused", () => {
		expect(transitionSupportJob(queued({ id: "s-4" }), hostile())).toEqual({
			ok: false,
			error: "unknown_state",
		});
		expect(canSupportTransition(hostile(), "RUNNING")).toBe(false);
		expect(assignSupportProfile(queued({ id: "s-5" }), hostile())).toEqual({
			ok: false,
			error: "invalid_profile",
		});
	});
});
