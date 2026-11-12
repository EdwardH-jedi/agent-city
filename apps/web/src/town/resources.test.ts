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
import { createPipelineTargets, paletteColors } from "./pipeline.ts";
import { buildTownWorld, type TownWorld } from "./world.ts";

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
	world.stage([kangaroo]); // the actor layer makes its sprite (material + atlas map clone) on first sync
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
			const world = buildTownWorld({ time });
			const { geos, mats, texs, targets } = everything(world);
			expect(world.actors.sprites.size).toBe(1);
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

	test("the pylon and the door lamps take a board view; a disposed world ignores it", () => {
		const world = buildTownWorld({ time: "day" });
		const view = {
			title: "AGENT OFFICE",
			rows: [
				{
					lot: "engineering",
					label: "ENGINR",
					deg: 0,
					lastEvidenceS: null,
					working: 1,
					waiting: 0,
					idle: 0,
					unknown: 0,
				},
			],
			offline: false,
		};
		world.setBoard(view);
		expect(world.ring.lampStates().engineering).toBe("working");
		expect(world.ring.lampStates().qa).toBe("off");
		world.dispose();
		world.setBoard({ ...view, offline: true });
		expect(world.ring.lampStates().engineering).toBe("working");
	});

	test("repeated build/dispose cycles leave every resource disposed", () => {
		for (let i = 0; i < 3; i += 1) {
			const world = buildTownWorld({ time: i % 2 ? "night" : "day" });
			const { geos, mats, texs, targets } = everything(world);
			const live = new Set<object>([...geos, ...mats, ...texs]);
			for (const r of live) r.addEventListener("dispose", () => live.delete(r));
			world.dispose();
			targets.dispose();
			expect(live.size).toBe(0);
		}
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
