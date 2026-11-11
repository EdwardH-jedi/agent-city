// The middle column (design doc §4): the 3D campus when WebGL works, the 2D tile grid otherwise. Both
// draw the same VillageModel. The scene is a lazy chunk, fetched only when a WebGL context can be
// made; if the chunk cannot be loaded, WebGL cannot start, or its context is lost, the 2D grid takes
// over for good (until reload). The view adds no motion of its own: a dim village (reports stopped)
// is a CSS filter, and the evening tone darkens a little during the quiet hours (`?quiet=`).
import {
	type ComponentType,
	lazy,
	Suspense,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { VillageModel } from "../board/model.ts";
import { isQuiet, parseSoundPrefs } from "../board/sound.ts";
import { Village2d } from "../board/Village2d.tsx";
import {
	prefersReducedMotion,
	watchReducedMotion,
	webglAvailable,
} from "./environment.ts";
import { type CampusSceneProps, toCampusModel } from "./presentation.ts";

/** Stands in for the scene when its chunk cannot be loaded: it only says so, once. */
function SceneMissing({ onUnavailable }: CampusSceneProps) {
	useEffect(() => onUnavailable("init_failed"), [onUnavailable]);
	return null;
}

const CampusScene = lazy(
	(): Promise<{ default: ComponentType<CampusSceneProps> }> =>
		import("./CampusScene.tsx").catch(() => ({ default: SceneMissing })),
);

/** Only mounted while the scene is shown, so its OS listener goes when the 2D grid takes over. */
function SceneHost({
	model,
	onUnavailable,
}: {
	model: VillageModel;
	onUnavailable: () => void;
}) {
	const [reduced, setReduced] = useState(prefersReducedMotion);
	useEffect(() => watchReducedMotion(setReduced), []);
	const scene = useMemo(() => toCampusModel(model), [model]);
	return (
		<Suspense fallback={null}>
			<CampusScene
				model={scene}
				reducedMotion={reduced}
				onUnavailable={onUnavailable}
			/>
		</Suspense>
	);
}

export function CampusView({
	model,
	now,
}: {
	model: VillageModel;
	now: number;
}) {
	const [gl, setGl] = useState(webglAvailable);
	const prefs = useMemo(() => parseSoundPrefs(window.location.search), []);
	const night = isQuiet(prefs, new Date(now));
	const fallBack = useMemo(() => () => setGl(false), []);
	if (!gl) return <Village2d model={model} now={now} />;
	return (
		<main
			className={`village campus${model.status.dim ? " village-dim" : ""}${night ? " campus-night" : ""}`}
			aria-label="프로젝트 마을"
		>
			<SceneHost model={model} onUnavailable={fallBack} />
			{model.village.folded > 0 && (
				<p className="quiet campus-folded">조용함 {model.village.folded}곳</p>
			)}
		</main>
	);
}
