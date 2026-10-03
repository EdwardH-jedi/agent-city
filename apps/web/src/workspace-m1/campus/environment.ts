// Browser capability probes for the campus DOM layer (no three; safe to import anywhere, touches
// `window`/`document` only when called).

/**
 * True when a WebGL context can be created. The probe context is released immediately, so the
 * check costs no lasting GPU slot; the scene chunk is not even fetched when this is false.
 */
export function webglAvailable(): boolean {
	try {
		if (typeof document === "undefined") return false;
		const canvas = document.createElement("canvas");
		const gl = (canvas.getContext("webgl2") ??
			canvas.getContext("webgl")) as WebGLRenderingContext | null;
		if (!gl) return false;
		gl.getExtension("WEBGL_lose_context")?.loseContext();
		return true;
	} catch {
		return false;
	}
}

const REDUCED = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
	try {
		return typeof window !== "undefined" && window.matchMedia(REDUCED).matches;
	} catch {
		return false;
	}
}

/** Calls `fn` whenever the OS reduced-motion preference changes; returns the unsubscribe. */
export function onReducedMotionChange(
	fn: (reduced: boolean) => void,
): () => void {
	try {
		const mq = window.matchMedia(REDUCED);
		const handler = (e: MediaQueryListEvent) => fn(e.matches);
		mq.addEventListener("change", handler);
		return () => mq.removeEventListener("change", handler);
	} catch {
		return () => undefined;
	}
}
