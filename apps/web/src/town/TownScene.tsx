// Lazily loaded ring town (design doc 12). A thin React shell around stage.ts, like CampusScene: it
// creates the stage on mount, hands it each new model, and disposes it on unmount. The canvas is
// aria-hidden — every word the owner needs is in the side columns.
import { useEffect, useLayoutEffect, useRef } from "react";
import type { CampusSceneProps } from "../campus/presentation.ts";
import type { InteriorNotice, InteriorSource } from "./interior/types.ts";
import type { TimeOfDay } from "./params.ts";
import { createTownStage, type TownStage } from "./stage.ts";

export interface TownSceneProps extends CampusSceneProps {
	time: TimeOfDay;
	requestedInterior?: string | null;
	interiorSource?: InteriorSource;
	onInteriorChange?: (inside: InteriorNotice | null) => void;
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
					requestedInterior: latest.current.requestedInterior,
					interiorSource: latest.current.interiorSource,
				},
				{
					onContextLost: () => latest.current.onUnavailable("context_lost"),
					onReady: () => latest.current.onReady?.(),
					onInteriorChange: (inside) =>
						latest.current.onInteriorChange?.(inside),
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

	const { model, reducedMotion, time, requestedInterior, interiorSource } =
		props;
	useEffect(() => {
		stage.current?.update({
			model,
			reducedMotion,
			time,
			requestedInterior,
			interiorSource,
		});
	}, [model, reducedMotion, time, requestedInterior, interiorSource]);

	return <div ref={host} className="town-stage" aria-hidden="true" />;
}
