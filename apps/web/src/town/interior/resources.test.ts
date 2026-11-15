import { expect, test } from "bun:test";
import {
	type BufferGeometry,
	type Material,
	type Mesh,
	Sprite,
	type Texture,
} from "three";
import { demoData } from "../../board/demo.ts";
import { toVillageModel } from "../../board/model.ts";
import { toCampusModel } from "../../campus/presentation.ts";
import { createInteriorScene } from "./scene.ts";

test("still holds the actual sprite position; reduced motion settles a new session", () => {
	const now = Date.UTC(2026, 10, 16),
		data = demoData(now, "interior");
	data.sessions = data.sessions.slice(0, 1).map((s) => ({
		...s,
		started_at: new Date(now).toISOString(),
		last_event_at: new Date(now).toISOString(),
	}));
	const model = toVillageModel({ ...data, now, conn: "open" }),
		repo = toCampusModel(model).repos[0];
	if (!repo) throw Error("no repo");
	const source = { model, sessions: data.sessions, events: [], now },
		room = createInteriorScene(repo);
	try {
		const pos = () =>
			room.actors.sprites.get("crew:0")?.sprite.position.toArray();
		room.update(source, repo, now + 250, false, { rtW: 384, rtH: 340 });
		const beforeStop = pos();
		room.update(
			{
				...source,
				model: { ...model, status: { ...model.status, dim: true } },
			},
			repo,
			now + 500,
			false,
			{ rtW: 384, rtH: 340 },
		);
		const frozen = pos();
		expect(frozen).toEqual(beforeStop);
		room.update(
			{
				...source,
				model: { ...model, status: { ...model.status, dim: true } },
			},
			repo,
			now + 30_000,
			false,
			{ rtW: 384, rtH: 340 },
		);
		expect(pos()).toEqual(frozen);
		room.update(source, repo, now + 250, true, { rtW: 384, rtH: 340 });
		expect(pos()).not.toEqual(frozen);
		const settled = pos();
		room.update(source, repo, now + 4_000, false, { rtW: 384, rtH: 340 });
		expect(pos()).toEqual(settled);
	} finally {
		room.dispose();
	}
});

test("interior mount/draw/unmount releases every reachable GPU resource exactly once", () => {
	const now = Date.UTC(2026, 10, 16);
	const data = demoData(now, "interior");
	const model = toVillageModel({ ...data, now, conn: "open" });
	const repo = toCampusModel(model).repos[0];
	if (!repo) throw Error("no repo");
	const room = createInteriorScene(repo);
	room.update(
		{ model, sessions: data.sessions, events: data.events, now },
		repo,
		now,
		false,
		{ rtW: 384, rtH: 340 },
		true,
	);
	expect(room.people).toHaveLength(4);
	expect(room.actors.sprites.size).toBe(10);
	const resources = new Set<BufferGeometry | Material | Texture>();
	room.scene.traverse((o) => {
		const m = o as Partial<Mesh>;
		if (m.geometry && !(o instanceof Sprite)) resources.add(m.geometry);
		for (const material of Array.isArray(m.material)
			? m.material
			: m.material
				? [m.material]
				: []) {
			resources.add(material);
			for (const v of Object.values(material))
				if (v && typeof v === "object" && (v as Texture).isTexture)
					resources.add(v as Texture);
		}
	});
	resources.add(room.actors.texture);
	expect(resources.size).toBeGreaterThan(100);
	const released = new Map<unknown, number>();
	for (const r of resources)
		r.addEventListener("dispose", () => {
			released.set(r, (released.get(r) ?? 0) + 1);
		});
	room.dispose();
	room.dispose();
	expect(
		[...resources]
			.filter((r) => released.get(r) !== 1)
			.map((r) => r.constructor.name),
	).toEqual([]);
	expect(room.registry.size).toBe(0);
	expect(room.registry.errors).toEqual([]);
	expect(room.frames.size).toBe(0);
	expect(room.actors.sprites.size).toBe(0);
});
