// N12 end to end on one fake clock: heartbeats posted to the real hub app (in-memory DB) → its `machine`
// messages and GET /api/machines → mergeMachines / machinesAt → the board's 60 s count. One screen stays open
// through the cockpit's quiet spell (ws path); another is opened at R+30 from the REST snapshot (reload path).
// No network, no wall clock, no real DB file.
import { describe, expect, test } from "bun:test";
import type { MachineView } from "@agent-city/schema";
import { openDb } from "../../../hub/src/db.ts";
import { createApp } from "../../../hub/src/index.ts";
import { machinesAt, mergeMachines } from "../merge.ts";
import { runIn, screen, T0 } from "./fixtures.ts";

const S = 1_000;
const TOKEN = "test-ingest-token";
const at = (sec: number) => new Date(T0 + sec * S).toISOString();
// the cockpit beats every 5 s to 50 s, is silent, and beats again from R = 1000 s
const R = 1000;
const beatsAt = (sec: number) => sec % 5 === 0 && (sec <= 50 || sec >= R);

function hub() {
	const db = openDb(":memory:");
	const published: { kind: string; data: unknown }[] = [];
	let clock = T0;
	const app = createApp({
		db,
		ingestToken: TOKEN,
		publish: (kind, data) => published.push({ kind, data }),
		now: () => new Date(clock),
	});
	let seq = 0;
	return {
		published,
		async tick(sec: number) {
			clock = T0 + sec * S;
			if (!beatsAt(sec)) return;
			const body = JSON.stringify({
				schema: 1,
				machine_id: "cockpit",
				boot_id: "boot-aaaa-0001",
				seq: seq++,
				sent_at: at(sec),
				interval_s: 5,
			});
			const res = await app.request("/ingest/heartbeat", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": String(new TextEncoder().encode(body).length),
					authorization: `Bearer ${TOKEN}`,
				},
				body,
			});
			expect(res.status).toBe(200);
		},
		async snapshot(): Promise<MachineView[]> {
			const res = await app.request("/api/machines");
			return ((await res.json()) as { machines: MachineView[] }).machines;
		},
	};
}

const waiting = runIn("waiting_owner", {
	reason: "AWAITING_PLAN_APPROVAL",
	status: "READY",
	last_progress_at: at(100),
});

/** A board fed like useHub: one snapshot when it opens, then every `machine` message in order. */
function board(strip: boolean) {
	const s = screen("?quiet=off");
	let machines: MachineView[] = [];
	let seen = 0;
	const old = (ms: MachineView[]) =>
		strip ? ms.map(({ recent_gaps: _, ...m }) => m as MachineView) : ms;
	return {
		open(
			snapshot: MachineView[],
			published: { kind: string; data: unknown }[],
		) {
			machines = mergeMachines([], old(snapshot));
			seen = published.length;
		},
		step(sec: number, published: { kind: string; data: unknown }[]) {
			const fresh = published
				.slice(seen)
				.filter((p) => p.kind === "machine")
				.map((p) => p.data as MachineView);
			seen = published.length;
			machines = mergeMachines(machines, old(fresh));
			const now = T0 + sec * S;
			const r = s.step(now, {
				runs: [waiting],
				sessions: [],
				machines: machinesAt(machines, now),
				districts: {},
				eventsByRun: new Map(),
			});
			return { sec, visits: r.model.visits.map((v) => v.id), cues: r.cues };
		},
	};
}

async function play(strip: boolean, reloadAt: number, end: number) {
	const h = hub();
	const watched = board(strip);
	const reloaded = board(strip);
	const a: ReturnType<ReturnType<typeof board>["step"]>[] = [];
	const b: typeof a = [];
	for (let sec = 0; sec <= end; sec++) {
		await h.tick(sec);
		if (sec === 0) watched.open(await h.snapshot(), h.published);
		if (sec === reloadAt) reloaded.open(await h.snapshot(), h.published);
		a.push(watched.step(sec, h.published));
		if (sec >= reloadAt) b.push(reloaded.step(sec, h.published));
	}
	return {
		watched: a,
		reloaded: b,
		gaps: (await h.snapshot())[0]?.recent_gaps,
	};
}

describe("N12 end to end: hub gaps → snapshot / ws → the 60 s count", () => {
	test("the hub stores the quiet spell; a reload at R+30 shows the 결재 at R+60, like the screen that watched", async () => {
		const { watched, reloaded, gaps } = await play(false, R + 30, R + 120);
		expect(gaps).toEqual([
			{ from_at: at(50), until_at: at(R), boot_changed: false },
		]);
		expect(reloaded).toEqual(watched.filter((t) => t.sec >= R + 30));
		const first = reloaded.find((t) => t.visits.length > 0);
		expect(first?.sec).toBe(R + 60);
		expect(reloaded.flatMap((t) => t.cues.map((c) => `${t.sec}:${c}`))).toEqual(
			[`${R + 60}:knock`],
		);
	});

	test("an older hub's payload (no recent_gaps): the reload falls back to counting from the wait's start", async () => {
		const { reloaded } = await play(true, R + 30, R + 40);
		expect(reloaded[0]?.visits).toEqual(["cockpit:demo-flow-1"]);
	});
});
