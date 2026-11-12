// The middle column as the ring town (design doc 12, `?scene=town`): the town when WebGL works, the 2D
// tile grid otherwise — the same order and fallback as CampusView. The scene is a lazy chunk, fetched
// only when a WebGL context can be made; if the chunk cannot be loaded, WebGL cannot start, or its
// context is lost, the 2D grid takes over for good (until reload). This file imports no engine and no
// three: the first screen's text never waits for the town.
import {
	type ComponentType,
	lazy,
	Suspense,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { VillageModel } from "../board/model.ts";
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

/** Only mounted while the scene is shown, so its OS listener goes when the 2D grid takes over. */
function SceneHost({
	model,
	time,
	onUnavailable,
}: {
	model: VillageModel;
	time: TimeOfDay;
	onUnavailable: () => void;
}) {
	const [reduced, setReduced] = useState(prefersReducedMotion);
	useEffect(() => watchReducedMotion(setReduced), []);
	const scene = useMemo(() => toCampusModel(model), [model]);
	return (
		<Suspense fallback={null}>
			<TownScene
				model={scene}
				reducedMotion={reduced}
				time={time}
				onUnavailable={onUnavailable}
			/>
		</Suspense>
	);
}

export function TownView({ model, now }: { model: VillageModel; now: number }) {
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
			<SceneHost model={model} time={time} onUnavailable={fallBack} />
			{model.village.folded > 0 && (
				<p className="quiet campus-folded">조용함 {model.village.folded}곳</p>
			)}
		</main>
	);
}
