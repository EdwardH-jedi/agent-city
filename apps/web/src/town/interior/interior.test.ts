import { describe, expect, test } from "bun:test";
import type { Session } from "@agent-city/schema";
import { demoData } from "../../board/demo.ts";
import { toVillageModel } from "../../board/model.ts";
import { visibleSessions } from "../../board/session-panel.ts";
import { toCampusModel } from "../../campus/presentation.ts";
import { townCrew } from "../crew.ts";
import { crewLook } from "../crew-sprites.ts";
import { occupants } from "./occupants.ts";
import { ENTRY_MS, ritualAt } from "./ritual.ts";
import { interiorLabel, PHASE_TEXT, statusText } from "./status-text.ts";
import { matchesTheme, themeFor } from "./themes/index.ts";
import { office } from "./themes/office.ts";
import type { InteriorSource } from "./types.ts";

const NOW = Date.UTC(2026, 10, 16, 0);
const source = (): InteriorSource => {
	const data = demoData(NOW, "interior");
	return {
		model: toVillageModel({ ...data, now: NOW, conn: "open" }),
		sessions: data.sessions,
		events: data.events,
		now: NOW,
	};
};
const REPO = "demo/station0";

describe("interior occupants use the panel's facts", () => {
	test("same active/waiting set as visibleSessions; same looks, two actual companions", () => {
		const s = source(),
			rows = occupants(s, REPO, office);
		expect(rows.map((r) => r.id).sort()).toEqual(
			visibleSessions(s.sessions, s.model.waitingSessions, NOW)
				.filter((v) => v.status === "active" || v.status === "waiting")
				.map((v) => v.session.id)
				.sort(),
		);
		expect(rows.filter((r) => r.status === "active")).toHaveLength(3);
		expect(rows.filter((r) => r.status === "waiting")).toHaveLength(1);
		expect(rows.reduce((n, r) => n + r.companions, 0)).toBe(2);
		const outdoor = townCrew(s);
		for (const r of rows) {
			const outside = outdoor.find((p) => p.id === r.id);
			if (outside)
				expect(crewLook(r.id, r.provider, r.family)).toEqual(
					crewLook(outside.id, outside.provider, outside.family),
				);
		}
		expect(toCampusModel(s.model).repos.map((r) => r.repo_id)).toContain(REPO);
	});
	test("active four, waiting two, deterministic collision resolution, sticky seats", () => {
		const s = source();
		const base = s.sessions[0] as Session;
		s.sessions = Array.from({ length: 20 }, (_, i) => ({
			...base,
			id: `claude:seat-${i}`,
			status: i < 10 ? "active" : "waiting",
			last_event_at: new Date(NOW - i * 1000).toISOString(),
		}));
		const rows = occupants(s, REPO, office);
		expect(rows.filter((r) => r.status === "active")).toHaveLength(4);
		expect(rows.filter((r) => r.status === "waiting")).toHaveLength(2);
		for (const status of ["active", "waiting"]) {
			const group = rows.filter((r) => r.status === status);
			expect(new Set(group.map((r) => r.slot)).size).toBe(group.length);
		}
		expect(rows.filter((r) => r.status === "active").map((r) => r.id)).toEqual([
			"claude:seat-0",
			"claude:seat-1",
			"claude:seat-2",
			"claude:seat-3",
		]);
		expect(
			occupants({ ...s, sessions: [...s.sessions].reverse() }, REPO, office),
		).toEqual(rows);
		const reduced = occupants(
			{ ...s, sessions: s.sessions.slice(1) },
			REPO,
			office,
			rows,
		);
		for (const r of reduced) {
			const before = rows.find((p) => p.id === r.id);
			if (before) expect(r.slot).toBe(before.slot);
		}
	});
	test("no idle, stale, ended, repo-less or folded-building person", () => {
		const s = source();
		const base = s.sessions[0] as Session;
		s.sessions = (["idle", "stale", "ended"] as const).map((status, i) => ({
			...base,
			id: `claude:hidden-${i}`,
			status,
		}));
		expect(occupants(s, REPO, office)).toEqual([]);
		s.sessions = [{ ...base, repo_id: null }];
		expect(occupants(s, REPO, office)).toEqual([]);
		expect(occupants(source(), "demo/not-shown", office)).toEqual([]);
	});
	test("a reload or ordinary event cannot replay entry; a visible status transition can", () => {
		const s = source();
		const first = occupants(s, REPO, office);
		expect(first.every((r) => Date.parse(r.since) < NOW - ENTRY_MS)).toBe(true);
		const changed = {
			...s,
			sessions: s.sessions.map((p) => ({
				...p,
				last_event_at: new Date(NOW).toISOString(),
			})),
		};
		expect(occupants(changed, REPO, office).map((r) => r.since)).toEqual(
			first.map((r) => r.since),
		);
		expect(occupants(changed, REPO, office, first).map((r) => r.since)).toEqual(
			first.map((r) => r.since),
		);
		const waiting = first.find((r) => r.status === "waiting");
		changed.sessions = changed.sessions.map((p) =>
			p.id === waiting?.id ? { ...p, status: "active" } : p,
		);
		expect(
			occupants(changed, REPO, office, first).find((p) => p.id === waiting?.id)
				?.since,
		).toBe(new Date(NOW).toISOString());
	});
});

describe("interior theme and timeline", () => {
	test("exact or hyphen-prefix match, unknown falls back to office", () => {
		expect(matchesTheme("STATION0", "station0")).toBe(true);
		expect(matchesTheme("station0-tests", "station0")).toBe(true);
		expect(matchesTheme("station01", "station0")).toBe(false);
		expect(themeFor("unlisted")).toBe(office);
	});
	test("entry is at the data time, reduced motion settles, a frozen clock gives a frozen pose", () => {
		const slot = office.slots[0];
		if (!slot) throw Error("no slot");
		const since = new Date(NOW).toISOString();
		expect(ritualAt(office, slot, since, NOW, false)).toMatchObject(
			office.entrance,
		);
		expect(ritualAt(office, slot, since, NOW + ENTRY_MS, false)).toMatchObject({
			x: slot.x,
			z: slot.z,
			walking: false,
		});
		expect(ritualAt(office, slot, since, NOW, true)).toMatchObject({
			x: slot.x,
			z: slot.z,
			walking: false,
		});
		expect(ritualAt(office, slot, since, NOW + 300, false)).toEqual(
			ritualAt(office, slot, since, NOW + 300, false),
		);
	});
});

describe("status board table", () => {
	for (const [phase, text] of PHASE_TEXT.entries())
		test(`phase ${phase}: ${text}`, () => {
			const s = source();
			s.model.now = s.model.now.map((r) => ({ ...r, phase_index: phase }));
			expect(statusText(s.model, REPO)).toBe(text);
		});
	test("unmapped phase counts; pause; no run gives label; bounded label", () => {
		const s = source();
		s.model.now = s.model.now.map((r) => ({ ...r, phase_index: -1 }));
		expect(statusText(s.model, REPO)).toMatch(/^ACTIVE 3 WAIT \d+$/);
		s.model.now = [];
		s.model.paused = [
			{ key: "a", project_id: REPO, since: new Date(NOW).toISOString() },
		];
		expect(statusText(s.model, REPO)).toBe("PAUSED");
		s.model.paused = [];
		expect(statusText(s.model, REPO)).toBe("STATION0");
		expect(statusText(s.model, "missing")).toBe("");
		expect(interiorLabel("a".repeat(100))).toHaveLength(40);
	});
	for (const carry of ["folder", "binder"] as const)
		test(carry, () => {
			const s = source();
			const demo = demoData(NOW);
			const other = toVillageModel({ ...demo, now: NOW, conn: "open" });
			const visit = other.visits.find((v) => v.kind === "sign");
			if (!visit) throw Error("fixture missing sign");
			s.model.visits = [{ ...visit, project_id: REPO, carry }];
			expect(statusText(s.model, REPO)).toBe(
				carry === "binder" ? "HOLD" : "WAIT",
			);
		});
});
