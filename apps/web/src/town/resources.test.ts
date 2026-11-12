// Disposal of the ring town (doc 12 §6.4), with real three objects and no WebGL: the world (ring scene,
// pylon, orbit rig, sprite atlas, actor layer with the kangaroo synced in) plus the pipeline's render
// target and blit quad. Every geometry, material and texture reachable from them is disposed exactly
// once; repeated build/dispose cycles leave nothing. Also: the global colour-management switch the
// original turns off is handed back.
import { describe, expect, test } from "bun:test";
import {
	type BufferGeometry,
	ColorManagement,
	type Material,
	type Mesh,
	type Object3D,
	Sprite,
	type Texture,
} from "three";
import { assignLots, buildLots } from "./lots.ts";
import { createPipelineTargets, paletteColors } from "./pipeline.ts";
import { buildTownWorld, type TownWorld } from "./world.ts";

const repo = (id: string, active: number) => ({
	repo_id: id,
	label: id.split("/")[1] ?? id,
	active_tasks: active,
	monitors: [],
	pending_requests: 0,
	has_stopped: false,
});
const REPOS = [repo("a/alpha", 2), repo("b/beta-2", 0), repo("c/gamma", 4)];
/** Three projects, five empty slots, HQ and the cafe: the real-data path. */
const LOTS3 = buildLots(
	assignLots(
		new Map(),
		REPOS.map((r) => r.repo_id),
	),
	REPOS,
);

function resourcesOf(roots: Object3D[]) {
	const geos = new Set<BufferGeometry>();
	const mats = new Set<Material>();
	const texs = new Set<Texture>();
	const addMat = (mat: Material) => {
		mats.add(mat);
		for (const v of Object.values(mat))
			if (v && typeof v === "object" && (v as Texture).isTexture)
				texs.add(v as Texture);
	};
	for (const root of roots)
		root.traverse((o) => {
			const m = o as Partial<Mesh>;
			// three's Sprite shares one internal quad geometry across every sprite; nobody owns it
			if (m.geometry && !(o instanceof Sprite)) geos.add(m.geometry);
			const list = Array.isArray(m.material)
				? m.material
				: m.material
					? [m.material]
					: [];
			for (const mat of list) addMat(mat);
		});
	return { geos, mats, texs };
}

const kangaroo = {
	id: "player",
	kind: "player" as const,
	x: 0,
	z: 18,
	key: "roo|north|walk|0",
	lockedScale: true,
};

function everything(world: TownWorld) {
	world.rig.update(0, kangaroo.x, kangaroo.z);
	// the actor layer makes its sprites on first sync: the kangaroo (atlas map clone) and a lead (a
	// runtime TownArt frame, owned by the world's lead frames)
	world.stage([
		kangaroo,
		{
			id: "lead:v1",
			kind: "npc",
			x: 2,
			z: 16,
			key: "lead|o/alpha|folder|south|walk|0",
			shadow: true,
			sprite: {
				repo_id: "o/alpha",
				carry: "folder",
				facing: "south",
				action: "walk",
				phase: 0,
			},
		},
	]);
	const targets = createPipelineTargets();
	const r = resourcesOf([world.scene, targets.blitScene]);
	const bg = world.scene.background as Texture | null;
	if (bg?.isTexture) r.texs.add(bg);
	r.texs.add(world.actors.texture); // the atlas source the sprites' maps are cloned from
	// the target's own texture is released by the render target's dispose (three's
	// RenderTarget.dispose fires only on the target); it is checked through the target below
	r.texs.delete(targets.target.texture);
	return { ...r, targets };
}

describe("ring town disposal (real three objects, no renderer)", () => {
	for (const time of ["day", "dusk", "night"] as const) {
		test(`${time}: every reachable resource is disposed exactly once`, () => {
			const world = buildTownWorld({ time, lots: LOTS3 });
			for (const l of LOTS3) if (l.repo_id) world.setLitWindows(l.id, 1); // repaint in place
			const { geos, mats, texs, targets } = everything(world);
			expect(world.actors.sprites.size).toBe(2);
			expect(world.leads.size).toBe(1);
			expect(geos.size).toBeGreaterThan(100);
			expect(mats.size).toBeGreaterThan(100);
			expect(texs.size).toBeGreaterThan(50);
			const counts = new Map<object, number>();
			const all = [...geos, ...mats, ...texs];
			for (const r of all)
				r.addEventListener("dispose", () =>
					counts.set(r, (counts.get(r) ?? 0) + 1),
				);
			let rtDisposed = 0;
			targets.target.addEventListener("dispose", () => {
				rtDisposed += 1;
			});
			world.dispose();
			world.dispose();
			targets.dispose();
			const wrong = all
				.filter((r) => counts.get(r) !== 1)
				.map(
					(r) =>
						`${r.constructor.name}:${(r as { name?: string }).name ?? ""} ×${counts.get(r) ?? 0}`,
				);
			expect(wrong).toEqual([]);
			expect(rtDisposed).toBe(1);
		});
	}

	test("door lamps take explicit states; a disposed world ignores them", () => {
		const world = buildTownWorld({ time: "day", lots: LOTS3 });
		const rows = LOTS3.map((l) => ({ lot: l.id, lamp: "off" as const }));
		world.setLamps({
			offline: false,
			rows: [
				...rows.filter((r) => r.lot !== "engineering" && r.lot !== "qa"),
				{ lot: "engineering", lamp: "stopped" },
				{ lot: "qa", lamp: "waiting" },
			],
		});
		expect(world.ring.lampStates().engineering).toBe("stopped");
		expect(world.ring.lampStates().qa).toBe("waiting");
		expect(world.ring.lampStates().research).toBe("off");
		world.setLamps({ offline: true, rows });
		expect(new Set(Object.values(world.ring.lampStates()))).toEqual(
			new Set(["offline"]),
		);
		world.dispose();
		world.setLamps({ offline: false, rows });
		expect(world.ring.lampStates().qa).toBe("offline");
	});

	test("repeated build/dispose cycles leave every resource disposed", () => {
		for (let i = 0; i < 3; i += 1) {
			const world = buildTownWorld({
				time: i % 2 ? "night" : "day",
				lots: i % 2 ? LOTS3 : null,
			});
			const { geos, mats, texs, targets } = everything(world);
			const live = new Set<object>([...geos, ...mats, ...texs]);
			for (const r of live) r.addEventListener("dispose", () => live.delete(r));
			world.dispose();
			targets.dispose();
			expect(live.size).toBe(0);
		}
	});
});

describe("actors that come and go", () => {
	test("50 distinct lead ids, then none: every sprite, material and texture clone released; frames kept per look", () => {
		const world = buildTownWorld({ time: "day", lots: LOTS3 });
		const made: { dispose: number }[] = [];
		const lead = (i: number) => ({
			id: `lead:v${i}`,
			kind: "npc" as const,
			x: 2,
			z: 16,
			key: "lead|o/alpha|-|south|idle|0",
			shadow: true,
			sprite: {
				repo_id: "o/alpha",
				carry: null,
				facing: "south" as const,
				action: "idle" as const,
				phase: 0,
			},
		});
		const childrenBefore = world.scene.children.length;
		for (let i = 0; i < 50; i += 1) {
			world.stage([lead(i)]);
			for (const s of world.actors.sprites.values()) {
				const sp = s.sprite as unknown as {
					material: { addEventListener(t: string, f: () => void): void };
				};
				const rec = { dispose: 0 };
				sp.material.addEventListener("dispose", () => {
					rec.dispose += 1;
				});
				made.push(rec);
			}
		}
		expect(world.actors.sprites.size).toBe(1);
		world.stage([]);
		expect(world.actors.sprites.size).toBe(0);
		expect(world.scene.children.length).toBe(childrenBefore);
		// every material made for a lead was released exactly once (listeners stacked on the live one count once each)
		expect(made.every((r) => r.dispose >= 1)).toBe(true);
		expect(world.leads.size).toBe(1); // one look, one frame
		world.dispose();
	});
});

describe("colour management", () => {
	test("the palette switch is turned off while mounted and handed back once", () => {
		const before = ColorManagement.enabled;
		const restore = paletteColors();
		expect(ColorManagement.enabled).toBe(false);
		restore();
		expect(ColorManagement.enabled).toBe(before);
		ColorManagement.enabled = !before;
		restore(); // a second restore must not clobber a later change
		expect(ColorManagement.enabled).toBe(!before);
		ColorManagement.enabled = before;
	});
});
