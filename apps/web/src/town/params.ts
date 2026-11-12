// URL switches for the middle column (design doc 12 §0, §4). Pure and tiny: the board imports this
// statically, so it must not import the engine or three (the town is a lazy chunk).
//   ?scene=town            the ring town; anything else (or nothing) keeps the 3D campus
//   ?time=day|dusk|night   pins the town's time of day; otherwise RX's local hour picks it

export type SceneChoice = "campus" | "town";
export type TimeOfDay = "day" | "dusk" | "night";

const TIMES: readonly TimeOfDay[] = ["day", "dusk", "night"];

export function sceneOf(search: string): SceneChoice {
	return new URLSearchParams(search).get("scene") === "town"
		? "town"
		: "campus";
}

/** The pinned time of day, or null when the URL does not pin one (a misspelt value is ignored). */
export function pinnedTimeOf(search: string): TimeOfDay | null {
	const t = new URLSearchParams(search).get("time");
	return TIMES.find((x) => x === t) ?? null;
}

/** Day 07–17, dusk 17–20, night 20–07 (local hour, doc 12 §4). */
export function timeOfHour(hour: number): TimeOfDay {
	if (hour >= 7 && hour < 17) return "day";
	if (hour >= 17 && hour < 20) return "dusk";
	return "night";
}

export function timeOfDayAt(search: string, at: Date): TimeOfDay {
	return pinnedTimeOf(search) ?? timeOfHour(at.getHours());
}
