// The ring town's world: everything the original pipeline.mjs builds for preset 'ring' that needs no GL
// context — the ring scene (engine/scene-ring.mjs) with the leaderboard pylon, the orbit rig, the sprite
// atlas and the actor layer. Rebuilt whenever its spec changes (the time of day is baked into tints and
// lit windows, the lots carry the projects' signs and facades). The renderer and its targets outlive it
// (pipeline.ts); lamps, the pylon and lit windows change in place.
// No DOM, no GL: the resource test builds and disposes it in plain Bun.
import {
	Color,
	PerspectiveCamera,
	Quaternion,
	type Scene,
	Vector3,
} from "three";
import { type CrewFrames, createCrewFrames } from "./crew-sprites.ts";
import { createDoneFrames, type DoneFrames } from "./done-fx.ts";
import { horizonNdcY } from "./engine/camera-rig.mjs";
import {
	type BoardView,
	createLeaderboard,
	type Leaderboard,
} from "./engine/leaderboard.mjs";
import { createOrbitRig, type OrbitRig } from "./engine/orbit-camera.mjs";
import {
	resolvePreset,
	type ScenePreset,
	type TimeOfDay,
} from "./engine/presets.mjs";
import * as RING from "./engine/ring-layout.mjs";
import {
	buildRingScene,
	type LampInput,
	type RingScene,
} from "./engine/scene-ring.mjs";
import { buildSpriteAtlas, type SpriteAtlas } from "./engine/sprite-atlas.mjs";
import {
	type Actor,
	type ActorLayer,
	createActorLayer,
} from "./engine/sprites.mjs";
import { TownArt } from "./engine/town-art.mjs";
import { TownRooArtM2 } from "./engine/town-roo-art-m2.mjs";
import { createLeadFrames, type LeadFrames } from "./lead-sprites.ts";
import { lotsKey, type TownLot } from "./lots.ts";

/** What the world is built from: the time of day and the ten lots (lots.ts buildLots; null = the original). */
export interface WorldSpec {
	time: TimeOfDay;
	lots: readonly TownLot[] | null;
}

export const worldKey = (s: WorldSpec): string =>
	`${s.time}|${s.lots ? lotsKey(s.lots) : "original"}`;

export interface TownWorld {
	readonly spec: WorldSpec;
	readonly preset: ScenePreset;
	readonly ring: RingScene;
	readonly scene: Scene;
	readonly rig: OrbitRig;
	readonly board: Leaderboard;
	readonly atlas: SpriteAtlas;
	readonly actors: ActorLayer;
	/** The letterbox colour (the preset's sky). */
	readonly skyColor: Color;
	/** Pylon faces (pipeline.mjs setBoard). */
	setBoard(view: BoardView): void;
	/** Door lamps (an explicit state per lot; offline = the original offline look). */
	setLamps(input: LampInput): void;
	/** Repaints a lot's facade with n lit windows (no-op when unchanged). */
	setLitWindows(lotId: string, n: number): void;
	/** The leads' runtime frames (TownArt, made on demand). */
	readonly leads: LeadFrames;
	/** The crew's and their name tags' runtime frames (16 A1). */
	readonly crew: CrewFrames;
	/** The finish show's flag and confetti frames (17 §3). */
	readonly done: DoneFrames;
	/**
	 * Camera transform + actor sprites for this frame (pipeline.mjs render(), before the GL passes).
	 * `shot` blends the orbit camera toward a fixed shot (0 = orbit, 1 = the shot).
	 */
	stage(actors: readonly Actor[], shot?: CameraShot | null): void;
	dispose(): void;
}

/** A fixed camera: where it stands, what it looks at, and how far the orbit camera has blended to it. */
export interface CameraShot {
	position: { x: number; y: number; z: number };
	lookAt: { x: number; y: number; z: number };
	blend: number;
}

/** Same seed the original passes (none → 1). */
const SEED = 1;

export function buildTownWorld(spec: WorldSpec): TownWorld {
	const preset = resolvePreset("ring", null, spec.time);
	let board: Leaderboard | null = null;
	const ring = buildRingScene(preset, SEED, horizonNdcY(preset), {
		pylon: (o) => {
			board = createLeaderboard(o);
			return board.mesh;
		},
		...(spec.lots ? { lots: spec.lots } : {}),
	});
	const litShown = new Map(
		(spec.lots ?? []).map((l) => [l.id, l.litWindows ?? 0] as const),
	);
	const made = board as Leaderboard | null;
	if (!made) throw new Error("ring scene built no pylon");
	const rig = createOrbitRig(preset, RING);
	// S1 packs no townsfolk (doc 12 §4: no decorative people); the leads arrive in S2/S3.
	const atlas = buildSpriteAtlas({ rooArt: TownRooArtM2, npcs: [] });
	const leads = createLeadFrames(TownArt);
	const crew = createCrewFrames(TownArt);
	const done = createDoneFrames();
	const actors = createActorLayer(ring.scene, atlas, preset.actorTint, {
		playerPxPerTexel: preset.playerPxPerTexel,
		upright: preset.upright,
		// crew and tag sprites carry a `kind`; a lead's does not
		frameFor: (a) => done.frameFor(a) ?? crew.frameFor(a) ?? leads.frameFor(a),
	});
	const shotCam = new PerspectiveCamera();
	const q0 = new Quaternion();
	const p1 = new Vector3();
	const skyColor = new Color(preset.backdrop ?? preset.sky);
	let disposed = false;

	function stage(list: readonly Actor[], shot?: CameraShot | null): void {
		const snapped = rig.apply();
		const cam = rig.camera;
		const b = shot ? Math.max(0, Math.min(1, shot.blend)) : 0;
		if (shot && b > 0) {
			shotCam.position.set(shot.position.x, shot.position.y, shot.position.z);
			shotCam.lookAt(shot.lookAt.x, shot.lookAt.y, shot.lookAt.z);
			q0.copy(cam.quaternion);
			p1.set(shot.position.x, shot.position.y, shot.position.z);
			cam.position.lerp(p1, b);
			cam.quaternion.slerpQuaternions(q0, shotCam.quaternion, b);
			cam.updateMatrixWorld(true);
		}
		ring.skyline.follow(cam);
		// pipeline.mjs (M2.9.1): the guide the camera is locked on is drawn at the snapped focus, so it
		// holds one screen pixel while the world scrolls in whole-pixel steps.
		const f = rig.focus;
		const shown = list.map((a) =>
			a.kind === "player" &&
			Math.abs(a.x - f[0]) < 1e-6 &&
			Math.abs(a.z - f[1]) < 1e-6
				? { ...a, x: snapped[0], z: snapped[1] }
				: a,
		);
		actors.sync(rig.camera, shown);
	}

	return {
		spec,
		preset,
		ring,
		scene: ring.scene,
		rig,
		board: made,
		atlas,
		actors,
		leads,
		crew,
		done,
		skyColor,
		setBoard(view) {
			if (disposed) return;
			made.update(view);
		},
		setLamps(input) {
			if (disposed) return;
			ring.setLamps(input);
		},
		setLitWindows(lotId, n) {
			if (disposed || (litShown.get(lotId) ?? 0) === n) return;
			const lot = ring.meshes.colliders.get(`building:${lotId}`);
			let done = false;
			lot?.traverse((o) => {
				const set = o.userData.setLitWindows as
					| ((k: number) => void)
					| undefined;
				if (!done && typeof set === "function") {
					set(n);
					done = true;
				}
			});
			if (done) litShown.set(lotId, n);
		},
		stage,
		dispose() {
			if (disposed) return;
			disposed = true;
			// pipeline.mjs dispose order: actors, pylon, world
			actors.dispose();
			leads.dispose();
			crew.dispose();
			done.dispose();
			made.dispose();
			ring.dispose();
		},
	};
}
