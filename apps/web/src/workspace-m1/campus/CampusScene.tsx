// Lazily loaded WebGL campus (implements the frozen `CampusSceneProps`). A thin React shell around
// engine.ts: it creates the engine on mount, hands it each new model, and disposes it on unmount.
// A clicked building becomes one of the three intents; the canvas and its name tags are
// aria-hidden — CampusView's DOM layer is the accessible, always-usable control surface.
import { useEffect, useLayoutEffect, useRef } from "react";
import { type CampusEngine, createCampusEngine } from "./engine.ts";
import { dispatchIntent, intentForPick } from "./intents.ts";
import type { CampusSceneProps } from "./presentation.ts";

/** Extra notifications between CampusView and its own scene (not part of the frozen interface). */
export interface CampusSceneExtras {
	onReady?(): void;
	onRestored?(): void;
	/** Height (px) of the building buttons floating over the bottom of the stage. */
	bottomInset?: number;
}

export default function CampusScene(
	props: CampusSceneProps & CampusSceneExtras,
) {
	const host = useRef<HTMLDivElement>(null);
	const pinLayer = useRef<HTMLDivElement>(null);
	const engine = useRef<CampusEngine | null>(null);
	const latest = useRef(props);
	useLayoutEffect(() => {
		latest.current = props;
	});

	useEffect(() => {
		const h = host.current;
		const p = pinLayer.current;
		if (!h || !p) return;
		let made: CampusEngine | null = null;
		try {
			made = createCampusEngine(
				h,
				p,
				{
					model: latest.current.model,
					reducedMotion: latest.current.reducedMotion,
					bottomInset: latest.current.bottomInset,
				},
				{
					onPick: (pick) => {
						const intent = intentForPick(pick, latest.current.model);
						if (intent) dispatchIntent(intent, latest.current.actions);
					},
					onContextLost: () => latest.current.onUnavailable?.("context_lost"),
					onRestored: () => latest.current.onRestored?.(),
					onReady: () => latest.current.onReady?.(),
				},
			);
		} catch {
			latest.current.onUnavailable?.("init_failed");
			return;
		}
		engine.current = made;
		return () => {
			engine.current = null;
			made?.dispose();
		};
	}, []);

	const { model, reducedMotion, bottomInset } = props;
	useEffect(() => {
		engine.current?.update({ model, reducedMotion, bottomInset });
	}, [model, reducedMotion, bottomInset]);

	return (
		<div className="cmp-scene" aria-hidden="true">
			<div ref={host} className="cmp-gl" />
			<div ref={pinLayer} className="cmp-pins" />
		</div>
	);
}
