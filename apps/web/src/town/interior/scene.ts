import {
	Color,
	Mesh,
	MeshBasicMaterial,
	PerspectiveCamera,
	PlaneGeometry,
} from "three";
import { clockText } from "../../board/today.ts";
import type { CampusRepo } from "../../campus/presentation.ts";
import { DisposalRegistry } from "../../campus/resources.ts";
import {
	type CrewSprite,
	createCrewFrames,
	crewKey,
	crewLook,
	type TagSprite,
	tagKey,
} from "../crew-sprites.ts";
import { resolvePreset } from "../engine/presets.mjs";
import { LAMP_COLORS } from "../engine/scene-ring.mjs";
import { buildSpriteAtlas } from "../engine/sprite-atlas.mjs";
import { type Actor, createActorLayer } from "../engine/sprites.mjs";
import { TownArt } from "../engine/town-art.mjs";
import { TownRooArtM2 } from "../engine/town-roo-art-m2.mjs";
import { lampOf } from "../lots.ts";
import type { StageLayout } from "../pipeline.ts";
import { fovFor } from "../world.ts";
import { type Occupant, occupants } from "./occupants.ts";
import { fill, letters, pixelTexture, rgb, upload } from "./pixels.ts";
import { ritualAt } from "./ritual.ts";
import { buildInteriorScene } from "./room-art.mjs";
import { interiorLabel, statusText } from "./status-text.ts";
import { themeFor } from "./themes/index.ts";
import type { Rect } from "./themes/types.ts";
import type { InteriorSource } from "./types.ts";

export type InteriorScene = ReturnType<typeof createInteriorScene>;

/** Owns the room, never the renderer. One room is made on entry and wholly released on exit. */
export function createInteriorScene(
	repo: CampusRepo,
	registry = new DisposalRegistry(),
) {
	try {
		return build(repo, registry);
	} catch (error) {
		registry.disposeAll();
		throw error;
	}
}

function build(repo: CampusRepo, reg: DisposalRegistry) {
	const theme = themeFor(repo.label);
	const preset = resolvePreset(
		"interior",
		{ glow: 0, backdrop: 0x171b20 },
		"day",
	);
	const room = reg.track(
		buildInteriorScene(preset, theme.room, 1),
		"room meshes",
	);
	const scene = room.scene;
	const camera = new PerspectiveCamera(18, 4 / 3, 0.5, 120);
	const pitch = (preset.pitchDeg * Math.PI) / 180;
	const focus = { x: theme.room.width / 2, z: theme.room.depth / 2 };
	camera.position.set(
		focus.x,
		preset.heightOffset + preset.distance * Math.sin(pitch),
		focus.z + preset.distance * Math.cos(pitch),
	);
	camera.rotation.set(-pitch, 0, 0);
	camera.updateMatrixWorld(true);
	const frames = reg.track(createCrewFrames(TownArt), "crew frames");
	const atlas = buildSpriteAtlas({ rooArt: TownRooArtM2, npcs: [] });
	const actors = reg.track(
		createActorLayer(scene, atlas, null, {
			playerPxPerTexel: 1,
			upright: preset.upright,
			frameFor: (a) => frames.frameFor(a),
		}),
		"actor layer",
	);
	function plate(b: Rect, name: string) {
		const w = Math.round(b.w * 16),
			h = Math.round(b.h * 16);
		const map = reg.track(pixelTexture(w, h), `${name} texture`);
		const geo = reg.track(new PlaneGeometry(b.w, b.h), `${name} geometry`);
		const mat = reg.track(
			new MeshBasicMaterial({ map, toneMapped: false }),
			`${name} material`,
		);
		const mesh = new Mesh(geo, mat);
		mesh.position.set(b.x + b.w / 2, b.y + b.h / 2, b.z);
		scene.add(mesh);
		const img = { width: w, height: h, data: new Uint8Array(w * h * 4) };
		return { map, img, w, h };
	}
	const board = plate(theme.statusBoard, "status");
	const clock = theme.clock ? plate(theme.clock, "clock") : null;
	for (const sign of theme.signs ?? []) {
		const p = plate(sign, "sign");
		fill(p.img, 0, 0, p.w, p.h, rgb(0x294e54));
		letters(p.img, sign.text, 3, 3, rgb(0xd2d5bd));
		upload(p.map, p.img);
	}
	const bars = (theme.gateBars ?? [])
		.map((id) => scene.getObjectByName(id))
		.filter((b) => b !== undefined);
	const lampMat = reg.track(
		new MeshBasicMaterial({ color: 0x273136, toneMapped: false }),
		"entry lamp material",
	);
	for (const p of theme.entryLamp) {
		const geo = reg.track(
			new PlaneGeometry(0.5, 0.1875),
			"entry lamp geometry",
		);
		const lamp = new Mesh(geo, lampMat);
		lamp.position.set(p.x, p.y, p.z + 0.02);
		scene.add(lamp);
	}
	let people: Occupant[] = [];
	let lastSource: InteriorSource | null = null;
	let lastText = "";
	let lastClock = "";
	let frozenNow = 0;
	let stopped = false;
	const label = interiorLabel(repo.label);

	function update(
		source: InteriorSource,
		current: CampusRepo,
		wall: number,
		reduced: boolean,
		layout: Pick<StageLayout, "rtW" | "rtH">,
		ownerSince: string | null = null,
	) {
		if (reg.disposed) return;
		if (source !== lastSource) {
			people = occupants(source, repo.repo_id, theme, people);
			lastSource = source;
		}
		// Freeze the exact last pose while reports are cut; a reduced-motion room shows settled poses.
		if (!source.model.status.dim || !frozenNow) frozenNow = wall;
		stopped = source.model.status.dim;
		const now = stopped ? frozenNow : wall;
		camera.aspect = layout.rtW / layout.rtH;
		camera.fov = fovFor(18, layout.rtH);
		camera.updateProjectionMatrix();
		const text = statusText(source.model, repo.repo_id);
		const boardKey = `${label}|${text}`;
		if (boardKey !== lastText) {
			lastText = boardKey;
			const { img, w, h } = board;
			const colors = theme.boardColors ?? {
				frame: 0x6d7975,
				background: 0xe0ddc8,
				ink: 0x30433f,
			};
			fill(img, 0, 0, w, h, rgb(colors.frame));
			fill(img, 1, 1, w - 2, h - 2, rgb(colors.background));
			letters(img, label, 4, 3, rgb(colors.ink), 2);
			if (text !== label) letters(img, text, 4, h - 14, rgb(colors.ink), 2);
			upload(board.map, img);
		}
		const localTime = clockText(wall);
		if (clock && localTime !== lastClock) {
			lastClock = localTime;
			fill(clock.img, 0, 0, clock.w, clock.h, rgb(0x253d45));
			letters(clock.img, localTime.replace(":", " "), 3, 3, rgb(0xd1d5b5), 2);
			fill(clock.img, 20, 5, 2, 2, rgb(0xd1d5b5));
			fill(clock.img, 20, 9, 2, 2, rgb(0xd1d5b5));
			upload(clock.map, clock.img);
		}
		const poses = people.map((p) =>
			p.status === "active"
				? ritualAt(theme, p.at, p.since, now, reduced)
				: { ...p.at, walking: false, phase: 0, light: false, open: false },
		);
		const ownerPose = ownerSince
			? ritualAt(
					theme,
					{ x: theme.gate.x, z: theme.gate.z - 2 },
					ownerSince,
					now,
					reduced,
				)
			: null;
		const cues = ownerPose ? [...poses, ownerPose] : poses;
		const lamp = lampOf(current);
		const c = lamp === "off" ? rgb(0x273136) : LAMP_COLORS[lamp];
		const blink =
			cues.some((p) => p.light) && Math.floor(now / 150) % 2 === 0 ? 0.3 : 1;
		lampMat.color
			.copy(new Color(c[0] / 255, c[1] / 255, c[2] / 255))
			.multiplyScalar(blink);
		// Only the middle lane, used by the timestamped path, opens. No cosmetic gate cycles.
		for (const [i, bar] of bars.entries())
			bar.scale.x = i === 1 && cues.some((p) => p.open) ? 0.12 : 1;
		const list: Actor[] = [];
		for (const [i, p] of people.entries()) {
			const pose = poses[i];
			if (!pose) continue;
			const look = crewLook(p.id, p.provider, p.family);
			const sprite: CrewSprite = {
				kind: "crew",
				look,
				facing: pose.walking ? "north" : p.at.facing,
				action: pose.walking && !stopped ? "walk" : "idle",
				phase: pose.walking && !stopped ? pose.phase : 0,
				small: false,
			};
			list.push({
				id: `crew:${i}`,
				kind: "npc",
				x: pose.x,
				z: pose.z,
				key: crewKey(sprite),
				lockedScale: false,
				shadow: true,
				sprite,
			});
			if (p.tag && p.status === "active") {
				const tag: TagSprite = { kind: "tag", text: p.tag, style: look.style };
				list.push({
					id: `tag:${i}`,
					kind: "npc",
					x: pose.x,
					z: pose.z,
					key: tagKey(tag),
					lockedScale: false,
					sprite: tag,
				});
			}
			for (let j = 0; j < p.companions; j++) {
				const small: CrewSprite = { ...sprite, small: true };
				list.push({
					id: `mate:${i}:${j}`,
					kind: "npc",
					x: pose.x + (j ? 0.85 : -0.85),
					z: pose.z + 0.4,
					key: crewKey(small),
					lockedScale: false,
					shadow: true,
					sprite: small,
				});
			}
		}
		if (ownerPose)
			list.push({
				id: "player",
				kind: "player",
				x: ownerPose.x,
				z: ownerPose.z,
				key: `roo|north|${ownerPose.walking ? "walk" : "idle"}|${ownerPose.walking ? ownerPose.phase : 0}`,
				lockedScale: false,
			});
		actors.sync(camera, list);
	}
	return {
		repo_id: repo.repo_id,
		label,
		theme,
		scene,
		camera,
		registry: reg,
		actors,
		frames,
		lampMat,
		get clockText() {
			return lastClock;
		},
		update,
		get people() {
			return people;
		},
		dispose() {
			reg.disposeAll();
			scene.clear();
		},
	};
}
