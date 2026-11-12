// The middle column as the ring town (design doc 12, the default scene; `?scene=campus` draws the 3D campus instead): the town when WebGL works, the 2D
// tile grid otherwise — the same order and fallback as CampusView. The scene is a lazy chunk, fetched
// only when a WebGL context can be made; if the chunk cannot be loaded, WebGL cannot start, or its
// context is lost, the 2D grid takes over for good (until reload). This file imports no engine and no
// three: the first screen's text never waits for the town.

import type { Session } from "@agent-city/schema";
import {
	type ComponentType,
	lazy,
	Suspense,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import type { VillageModel } from "../board/model.ts";
import { parseSessionWait } from "../board/sessions.ts";
import type { TailEvent } from "../board/tail.ts";
import { Village2d } from "../board/Village2d.tsx";
import {
	prefersReducedMotion,
	watchReducedMotion,
	webglAvailable,
} from "../campus/environment.ts";
import {
	type CampusSceneProps,
	toCampusModel,
} from "../campus/presentation.ts";
import { townCrew } from "./crew.ts";
import { type TimeOfDay, timeOfDayAt } from "./params.ts";

type TownSceneProps = CampusSceneProps & { time: TimeOfDay };

/** Stands in for the scene when its chunk cannot be loaded: it only says so, once. */
function SceneMissing({ onUnavailable }: TownSceneProps) {
	useEffect(() => onUnavailable("init_failed"), [onUnavailable]);
	return null;
}

const TownScene = lazy(
	(): Promise<{ default: ComponentType<TownSceneProps> }> =>
		import("./TownScene.tsx").catch(() => ({ default: SceneMissing })),
);

const TownMinimap = lazy(
	(): Promise<{ default: ComponentType }> =>
		import("./TownMinimap.tsx").catch(() => ({ default: () => null })),
);

const PixelTitle = lazy(
	(): Promise<{ default: ComponentType<{ text: string }> }> =>
		import("./pixel-title.tsx").catch(() => ({ default: () => null })),
);

// Whether the town scene is up (its first frame drawn, not fallen back to 2D). The minimap slot in the
// HQ column renders only then, so without WebGL (or before the scene's chunk loads) nothing is fetched.
let sceneUp = false;
const upListeners = new Set<() => void>();
function setSceneUp(v: boolean) {
	if (sceneUp === v) return;
	sceneUp = v;
	for (const f of upListeners) f();
}
const subscribeUp = (f: () => void) => {
	upListeners.add(f);
	return () => {
		upListeners.delete(f);
	};
};

/** The minimap for the top of the HQ column (the town): a lazy chunk, mounted only while the town runs. */
export function TownMinimapSlot() {
	const up = useSyncExternalStore(subscribeUp, () => sceneUp);
	if (!up) return null;
	return (
		<Suspense fallback={null}>
			<TownMinimap />
		</Suspense>
	);
}

/**
 * A panel title in the town's pixel font (15 §2): a lazy chunk, drawn only while the town runs (the
 * scene's chunk has the font already). Before that, and without WebGL, the head shows the DOM word.
 */
export function TownPixelWord({ text }: { text: string }) {
	const up = useSyncExternalStore(subscribeUp, () => sceneUp);
	if (!up) return null;
	return (
		<Suspense fallback={null}>
			<PixelTitle text={text} />
		</Suspense>
	);
}

/** Only mounted while the scene is shown, so its OS listener goes when the 2D grid takes over. */
function SceneHost({
	model,
	now,
	sessions,
	events,
	time,
	onUnavailable,
}: {
	model: VillageModel;
	now: number;
	sessions: readonly Session[];
	events: readonly TailEvent[];
	time: TimeOfDay;
	onUnavailable: () => void;
}) {
	const [reduced, setReduced] = useState(prefersReducedMotion);
	useEffect(() => watchReducedMotion(setReduced), []);
	// `?session_wait=` as the board reads it (when an old wait walks to the cafe)
	const [sessionWaitMs] = useState(() =>
		parseSessionWait(window.location.search),
	);
	// the SESSIONS panel's sessions as people (16 A1): the same sessions and events, nothing fetched
	const scene = useMemo(
		() =>
			toCampusModel(
				model,
				townCrew({ sessions, events, model, now, sessionWaitMs }),
			),
		[model, sessions, events, now, sessionWaitMs],
	);
	useEffect(() => () => setSceneUp(false), []);
	const unavailable = useMemo(
		() => () => {
			setSceneUp(false);
			onUnavailable();
		},
		[onUnavailable],
	);
	const ready = useMemo(() => () => setSceneUp(true), []);
	return (
		<Suspense fallback={null}>
			<TownScene
				model={scene}
				reducedMotion={reduced}
				time={time}
				onUnavailable={unavailable}
				onReady={ready}
			/>
		</Suspense>
	);
}

/** The one bubble at the HQ door (the newest report), above the stage while the town runs. Words, so not aria-hidden. */
function DoorBubble({ model }: { model: VillageModel }) {
	const up = useSyncExternalStore(subscribeUp, () => sceneUp);
	const door = useMemo(() => toCampusModel(model).door, [model]);
	if (!up || !door) return null;
	return (
		<p className="town-bubble">
			<b>{door.label}</b> {door.text}
		</p>
	);
}

export function TownView({
	model,
	now,
	sessions = [],
	events = [],
}: {
	model: VillageModel;
	now: number;
	/** The sessions and events useHub holds (the SESSIONS panel's), for the crew. */
	sessions?: readonly Session[];
	events?: readonly TailEvent[];
}) {
	const [gl, setGl] = useState(webglAvailable);
	const fallBack = useMemo(() => () => setGl(false), []);
	// `?time=` pins the look; otherwise the local hour picks it, re-read with the board's clock.
	const time = timeOfDayAt(window.location.search, new Date(now));
	if (!gl) return <Village2d model={model} now={now} />;
	return (
		<main
			className={`village town${model.status.dim ? " village-dim" : ""}`}
			aria-label="프로젝트 마을"
		>
			<SceneHost
				model={model}
				now={now}
				sessions={sessions}
				events={events}
				time={time}
				onUnavailable={fallBack}
			/>
			<DoorBubble model={model} />
			{model.village.folded > 0 && (
				<p className="quiet campus-folded">조용함 {model.village.folded}곳</p>
			)}
		</main>
	);
}
