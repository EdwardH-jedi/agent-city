import { cafe } from "./cafe.ts";
import { office } from "./office.ts";
import { station0 } from "./station0.ts";
import type { InteriorTheme } from "./types.ts";

export const themes: readonly InteriorTheme[] = [station0, cafe, office];
export const matchesTheme = (label: string, match: string): boolean => {
	const name = label.toLowerCase();
	return name === match || name.startsWith(`${match}-`);
};
export function themeFor(label: string): InteriorTheme {
	return (
		themes.find((t) => t.match.some((m) => matchesTheme(label, m))) ?? office
	);
}
