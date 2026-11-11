// The middle column (design doc §4): the 3D campus when WebGL works, the 2D grid otherwise. Both
// draw the same VillageModel. The scene is a lazy chunk, fetched only when a WebGL context can be
// made; if it cannot start or its context is lost, the 2D grid takes over for good (until reload).
// The view adds no motion of its own: a dim village (reports stopped) is a CSS filter, and the
// evening tone darkens a little more during the quiet hours (the same `?quiet=` as the sound).
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { VillageModel } from "../board/model.ts";
import { isQuiet, parseSoundPrefs } from "../board/sound.ts";
import { Village2d } from "../board/Village2d.tsx";
import {
	prefersReducedMotion,
	watchReducedMotion,
	webglAvailable,
} from "./environment.ts";
import { toCampusModel } from "./presentation.ts";

const CampusScene = lazy(() => import("./CampusScene.tsx"));

function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState(prefersReducedMotion);
	useEffect(() => watchReducedMotion(setReduced), []);
	return reduced;
}

export function CampusView({
	model,
	now,
}: {
	model: VillageModel;
	now: number;
}) {
	const [gl, setGl] = useState(webglAvailable);
	const reduced = useReducedMotion();
	const scene = useMemo(() => toCampusModel(model), [model]);
	const prefs = useMemo(() => parseSoundPrefs(window.location.search), []);
	const night = isQuiet(prefs, new Date(now));
	if (!gl) return <Village2d model={model} now={now} />;
	return (
		<main
			className={`village campus${model.status.dim ? " village-dim" : ""}${night ? " campus-night" : ""}`}
			aria-label="프로젝트 마을"
		>
			<Suspense fallback={null}>
				<CampusScene
					model={scene}
					reducedMotion={reduced}
					onUnavailable={() => setGl(false)}
				/>
			</Suspense>
			{model.village.folded > 0 && (
				<p className="quiet campus-folded">외 {model.village.folded}곳</p>
			)}
		</main>
	);
}
