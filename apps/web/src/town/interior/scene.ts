import {
	Color,
	Mesh,
	MeshBasicMaterial,
	PerspectiveCamera,
	PlaneGeometry,
} from "three";
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
	const b = theme.statusBoard;
	const w = Math.round(b.w * 16),
		h = Math.round(b.h * 16);
	const boardMap = reg.track(pixelTexture(w, h), "status texture");
	const boardGeo = reg.track(new PlaneGeometry(b.w, b.h), "status geometry");
	const boardMat = reg.track(
		new MeshBasicMaterial({ map: boardMap, toneMapped: false }),
		"status material",
	);
	const board = new Mesh(boardGeo, boardMat);
	board.position.set(b.x + b.w / 2, b.y + b.h / 2, b.z);
	scene.add(board);
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
	let frozenNow = 0;
	let stopped = false;
	const label = interiorLabel(repo.label);

	function update(
		source: InteriorSource,
		current: CampusRepo,
		wall: number,
		reduced: boolean,
		layout: Pick<StageLayout, "rtW" | "rtH">,
		owner = false,
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
			const img = { width: w, height: h, data: new Uint8Array(w * h * 4) };
			fill(img, 0, 0, w, h, rgb(0x6d7975));
			fill(img, 1, 1, w - 2, h - 2, rgb(0xe0ddc8));
			letters(img, label, 4, 4, rgb(0x30433f), 2);
			letters(img, text, 4, 20, rgb(0x30433f), 2);
			upload(boardMap, img);
		}
		const lamp = lampOf(current);
		const c = lamp === "off" ? rgb(0x273136) : LAMP_COLORS[lamp];
		lampMat.color.copy(new Color(c[0] / 255, c[1] / 255, c[2] / 255));
		const list: Actor[] = [];
		for (const [i, p] of people.entries()) {
			const pose =
				p.status === "active"
					? ritualAt(theme, p.at, p.since, now, reduced)
					: { ...p.at, walking: false, phase: 0 };
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
		if (owner)
			list.push({
				id: "player",
				kind: "player",
				x: theme.gate.x,
				z: theme.gate.z - 1.5,
				key: "roo|north|idle|0",
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
