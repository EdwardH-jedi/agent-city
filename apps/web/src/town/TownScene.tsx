// Lazily loaded ring town (design doc 12). A thin React shell around stage.ts, like CampusScene: it
// creates the stage on mount, hands it each new model, and disposes it on unmount. The canvas is
// aria-hidden — every word the owner needs is in the side columns.
import { useEffect, useLayoutEffect, useRef } from "react";
import type { CampusSceneProps } from "../campus/presentation.ts";
import type { TimeOfDay } from "./params.ts";
import { createTownStage, type TownStage } from "./stage.ts";

export interface TownSceneProps extends CampusSceneProps {
	time: TimeOfDay;
}

export default function TownScene(props: TownSceneProps) {
	const host = useRef<HTMLDivElement>(null);
	const stage = useRef<TownStage | null>(null);
	const latest = useRef(props);
	useLayoutEffect(() => {
		latest.current = props;
	});

	useEffect(() => {
		const h = host.current;
		if (!h) return;
		let made: TownStage | null = null;
		try {
			made = createTownStage(
				h,
				{
					model: latest.current.model,
					reducedMotion: latest.current.reducedMotion,
					time: latest.current.time,
				},
				{
					onContextLost: () => latest.current.onUnavailable("context_lost"),
					onReady: () => latest.current.onReady?.(),
				},
			);
		} catch {
			latest.current.onUnavailable("init_failed");
			return;
		}
		stage.current = made;
		return () => {
			stage.current = null;
			made?.dispose();
		};
	}, []);

	const { model, reducedMotion, time } = props;
	useEffect(() => {
		stage.current?.update({ model, reducedMotion, time });
	}, [model, reducedMotion, time]);

	return <div ref={host} className="town-stage" aria-hidden="true" />;
}
