// v0.1.1 optional B: when the spool cannot be written, a hub REJECTION must not count as sent —
// nothing may be reported delivered (and no offset may advance) unless the events reached the hub
// or were durably parked. Failures are injected (a Spool whose writes throw, a fake fetch), never
// real disk exhaustion.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IngestEvent } from "@agent-city/schema/core";
import {
	createTransport,
	deliver,
	type PostResult,
	Spool,
	type Transport,
} from "./spool.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "agentcity-spool-fallback-"));
	dirs.push(d);
	return d;
};

const ev = (id: string) =>
	({
		id,
		ts: new Date().toISOString(),
		machine_id: "cockpit",
		session_id: "s",
		provider: "claude",
		type: "PreToolUse",
	}) as IngestEvent;

/** A spool whose append fails (disk full / read-only), with a configurable reject path. */
class BrokenSpool extends Spool {
	constructor(
		dir: string,
		private readonly rejectWorks: boolean,
	) {
		super(dir);
	}
	override append(): void {
		throw new Error("ENOSPC (injected)");
	}
	override reject(lines: readonly string[]): void {
		if (!this.rejectWorks) throw new Error("EROFS (injected)");
		super.reject(lines);
	}
}

const transport = (r: PostResult): Transport => ({ post: async () => r });

describe("spool unwritable → direct POST fallback", () => {
	for (const [status, code] of [
		["400", 400],
		["413", 413],
		["422", 422],
	] as const)
		test(`hub answers ${status}: not 'sent'; parked durably → 'rejected'`, async () => {
			const dir = tmp();
			const fetchImpl = (async () =>
				new Response("{}", { status: code })) as unknown as typeof fetch;
			const t = createTransport(
				{ hubUrl: "http://127.0.0.1:9", ingestToken: "test-token" },
				1_000,
				fetchImpl,
			);
			const spool = new BrokenSpool(dir, true);
			expect(await deliver([ev("a"), ev("b")], spool, t)).toBe("rejected");
			// parked for inspection, not silently gone
			const parked = readFileSync(spool.rejectedFile, "utf8");
			expect(parked).toContain('"id":"a"');
			expect(parked).toContain('"id":"b"');
		});

	test("rejected AND the reject file cannot be written either → 'failed' (offsets must not advance)", async () => {
		const spool = new BrokenSpool(tmp(), false);
		expect(await deliver([ev("a")], spool, transport("rejected"))).toBe(
			"failed",
		);
	});

	test("timeout / no response → 'failed'", async () => {
		const hanging = ((_url: string, init: RequestInit) =>
			new Promise((_, reject) =>
				init.signal?.addEventListener("abort", () =>
					reject(new Error("aborted")),
				),
			)) as unknown as typeof fetch;
		const t = createTransport(
			{ hubUrl: "http://127.0.0.1:9", ingestToken: "test-token" },
			50,
			hanging,
		);
		expect(await deliver([ev("a")], new BrokenSpool(tmp(), true), t)).toBe(
			"failed",
		);
	});

	test("accepted → 'sent'; a mix of accepted and rejected chunks → 'rejected'", async () => {
		expect(
			await deliver([ev("a")], new BrokenSpool(tmp(), true), transport("ok")),
		).toBe("sent");
		let n = 0;
		const mixed: Transport = {
			post: async () => (n++ === 0 ? "ok" : "rejected"),
		};
		const many = Array.from({ length: 600 }, (_, i) => ev(`m${i}`)); // two chunks
		expect(await deliver(many, new BrokenSpool(tmp(), true), mixed)).toBe(
			"rejected",
		);
	});
});

describe("flush with a failing reject file keeps the events queued", () => {
	test("rejected chunk + unwritable reject file → nothing lost, remaining", async () => {
		const dir = tmp();
		class RejectFails extends Spool {
			override reject(): void {
				throw new Error("EROFS (injected)");
			}
		}
		const spool = new RejectFails(dir);
		spool.append([ev("keep-me")]);
		const r = await spool.flush(transport("rejected"));
		expect(r.remaining).toBe(true);
		expect(r.rejected).toBe(0);
		// still on disk (spool.jsonl or a claimed .flushing file), will be retried
		const queued = readdirSync(dir)
			.filter((n) => n === "spool.jsonl" || n.endsWith(".flushing"))
			.map((n) => readFileSync(join(dir, n), "utf8"))
			.join("");
		expect(queued).toContain("keep-me");
	});
});
