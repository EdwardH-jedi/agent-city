// Lazily loaded WebGL campus. A thin React shell around engine.ts: it creates the engine on mount,
// hands it each new model, and disposes it on unmount. The canvas and its tags are aria-hidden —
// every word the owner needs is in the side columns (design doc §2.4).
import { useEffect, useLayoutEffect, useRef } from "react";
import { type CampusEngine, createCampusEngine } from "./engine.ts";
import type { CampusModel } from "./presentation.ts";

export interface CampusSceneProps {
	model: CampusModel;
	/** prefers-reduced-motion: leads are already where they go. */
	reducedMotion: boolean;
	/** Called once if WebGL cannot start or the context is lost (the 2D grid takes over). */
	onUnavailable(reason: "context_lost" | "init_failed"): void;
	onReady?(): void;
}

export default function CampusScene(props: CampusSceneProps) {
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
				},
				{
					onContextLost: () => latest.current.onUnavailable("context_lost"),
					onRestored: () => undefined,
					onReady: () => latest.current.onReady?.(),
				},
			);
		} catch {
			latest.current.onUnavailable("init_failed");
			return;
		}
		engine.current = made;
		return () => {
			engine.current = null;
			made?.dispose();
		};
	}, []);

	const { model, reducedMotion } = props;
	useEffect(() => {
		engine.current?.update({ model, reducedMotion });
	}, [model, reducedMotion]);

	return (
		<div className="cmp-scene" aria-hidden="true">
			<div ref={host} className="cmp-gl" />
			<div ref={pinLayer} className="cmp-pins" />
		</div>
	);
}
