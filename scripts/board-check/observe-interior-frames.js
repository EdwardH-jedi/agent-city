// Observe native RAF completion, never schedule or delay an application frame. Adapted from the
// independent I3 review's trace-init.js. Only the synthetic tour-sign page installs this observer.
(() => {
	const trace = { frames: [], mutations: [], errors: [], overflow: false };
	window.__agentCityInteriorFrames = trace;
	const state = () => ({
		at: performance.now(),
		sign: Boolean(document.querySelector(".board.border-yellow")),
		inside:
			document.querySelector(".town-stage canvas")?.dataset.inside || null,
	});
	const raf = window.requestAnimationFrame.bind(window);
	window.requestAnimationFrame = (callback) =>
		raf((frame) => {
			callback(frame);
			if (trace.frames.length < 10_000)
				trace.frames.push({ frame, ...state() });
			else trace.overflow = true;
		});
	new MutationObserver((records) => {
		if (
			records.some(
				(r) =>
					r.attributeName === "data-inside" ||
					(r.attributeName === "class" &&
						r.target.classList?.contains("board")),
			)
		)
			trace.mutations.push(state());
	}).observe(document, {
		subtree: true,
		attributes: true,
		attributeFilter: ["class", "data-inside"],
	});
	window.addEventListener("error", (event) =>
		trace.errors.push(String(event.message)),
	);
	window.addEventListener("unhandledrejection", (event) =>
		trace.errors.push(String(event.reason)),
	);
})();
