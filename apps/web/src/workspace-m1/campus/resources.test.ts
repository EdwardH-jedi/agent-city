// Disposal: the registry (stubs) and the real campus scene graph (three objects, no WebGL). Every
// geometry, material and texture reachable from the scene is recorded at creation and disposed
// exactly once; repeated build/dispose cycles leave nothing behind; visitors allocate nothing.
import { describe, expect, test } from "bun:test";
import type { BufferGeometry, Material, Mesh, Object3D, Texture } from "three";
import { boundedPixelRatio, MAX_PIXEL_RATIO } from "./engine.ts";
import { campusLayout } from "./layout.ts";
import { DisposalRegistry } from "./resources.ts";
import { buildCampusWorld } from "./world.ts";

function stub(label: string, log: string[], fail = false) {
	let n = 0;
	return {
		label,
		get count() {
			return n;
		},
		dispose() {
			n += 1;
			log.push(label);
			if (fail) throw new Error(`boom ${label}`);
		},
	};
}

describe("DisposalRegistry", () => {
	test("releases everything once, in reverse order of creation", () => {
		const log: string[] = [];
		const reg = new DisposalRegistry();
		const a = reg.track(stub("geometry", log));
		const b = reg.track(stub("material", log));
		reg.defer(() => log.push("listener"), "listener");
		const c = reg.track(stub("texture", log));
		expect(reg.size).toBe(4);
		reg.disposeAll();
		expect(log).toEqual(["texture", "listener", "material", "geometry"]);
		expect([a.count, b.count, c.count]).toEqual([1, 1, 1]);
		expect(reg.disposed).toBe(true);
		expect(reg.size).toBe(0);
	});

	test("idempotent; tracking twice is one entry; tracking after disposal releases at once", () => {
		const log: string[] = [];
		const reg = new DisposalRegistry();
		const a = stub("a", log);
		reg.track(a);
		reg.track(a);
		expect(reg.size).toBe(1);
		reg.disposeAll();
		reg.disposeAll();
		expect(a.count).toBe(1);
		const late = reg.track(stub("late", log));
		expect(late.count).toBe(1);
		let ran = 0;
		reg.defer(() => {
			ran += 1;
		});
		expect(ran).toBe(1);
	});

	test("one failing release does not stop the others", () => {
		const log: string[] = [];
		const reg = new DisposalRegistry();
		const a = reg.track(stub("a", log));
		reg.track(stub("bad", log, true), "bad");
		const c = reg.track(stub("c", log));
		reg.disposeAll();
		expect([a.count, c.count]).toEqual([1, 1]);
		expect(reg.errors).toEqual(["bad"]);
	});
});

function resourcesOf(root: Object3D) {
	const geos = new Set<BufferGeometry>();
	const mats = new Set<Material>();
	const texs = new Set<Texture>();
	root.traverse((o) => {
		const m = o as Partial<Mesh>;
		if (m.geometry) geos.add(m.geometry);
		const list = Array.isArray(m.material)
			? m.material
			: m.material
				? [m.material]
				: [];
		for (const mat of list) {
			mats.add(mat);
			for (const v of Object.values(mat))
				if (v && typeof v === "object" && (v as Texture).isTexture)
					texs.add(v as Texture);
		}
	});
	return { geos, mats, texs };
}

describe("campus scene graph disposal (real three objects, no renderer)", () => {
	for (const n of [1, 4, 9]) {
		test(`${n} building(s): every reachable resource is tracked and disposed exactly once`, () => {
			const reg = new DisposalRegistry();
			const layout = campusLayout(
				Array.from({ length: n }, (_, i) => `owner/repo-${i}`),
			);
			const world = buildCampusWorld(layout, reg);
			// visitors of both gates and every material swap target the engine uses
			for (const kind of ["run", "result"] as const)
				for (let seat = 0; seat < 6; seat += 1)
					world.root.add(world.makeVisitor(kind, "#3d6fa8", seat).group);
			const { geos, mats, texs } = resourcesOf(world.root);
			expect(geos.size).toBeGreaterThan(50);
			expect(mats.size).toBeGreaterThan(30);
			expect(texs.size).toBe(4);
			const untracked = [...geos, ...mats, ...texs].filter((r) => !reg.has(r));
			expect(untracked.map((r) => r.constructor.name)).toEqual([]);

			// every tracked three resource fires `dispose` exactly once
			const counts = new Map<object, number>();
			for (const r of [...geos, ...mats, ...texs])
				r.addEventListener("dispose", () =>
					counts.set(r, (counts.get(r) ?? 0) + 1),
				);
			for (const m of [
				world.flagMats.attention,
				world.flagMats.danger,
				world.edgeMat,
				world.accentEdge("#26827a"),
				...Object.values(world.screenMats).flatMap((s) => [s.lit, s.dim]),
			])
				expect(reg.has(m)).toBe(true);
			reg.disposeAll();
			reg.disposeAll();
			for (const r of [...geos, ...mats, ...texs])
				expect(counts.get(r)).toBe(1);
			expect(reg.size).toBe(0);
			expect(reg.errors).toEqual([]);
		});
	}

	test("visitors allocate no resource: adding/removing figures keeps the registry size", () => {
		const reg = new DisposalRegistry();
		const world = buildCampusWorld(campusLayout(["a/x", "b/y"]), reg);
		// first visitor of each gate may create the shared document/skin materials once
		world.makeVisitor("run", "#3d6fa8", 0);
		world.makeVisitor("result", "#3d6fa8", 0);
		const size = reg.size;
		for (let i = 0; i < 50; i += 1) {
			const f = world.makeVisitor(i % 2 ? "run" : "result", "#3d6fa8", i % 5);
			world.root.add(f.group);
			world.root.remove(f.group);
		}
		expect(reg.size).toBe(size);
		reg.disposeAll();
	});

	test("repeated build/dispose cycles leave nothing tracked", () => {
		for (let i = 0; i < 5; i += 1) {
			const reg = new DisposalRegistry();
			buildCampusWorld(campusLayout(["a/x", "b/y", "c/z"]), reg);
			expect(reg.size).toBeGreaterThan(0);
			reg.disposeAll();
			expect(reg.size).toBe(0);
		}
	});
});

describe("device pixel ratio", () => {
	test("bounded to 2, sane defaults", () => {
		expect(MAX_PIXEL_RATIO).toBe(2);
		expect(boundedPixelRatio(3)).toBe(2);
		expect(boundedPixelRatio(1.5)).toBe(1.5);
		expect(boundedPixelRatio(undefined)).toBe(1);
		expect(boundedPixelRatio(Number.NaN)).toBe(1);
		expect(boundedPixelRatio(0)).toBe(1);
	});
});
