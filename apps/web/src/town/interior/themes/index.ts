import { office } from "./office.ts";
import type { InteriorTheme } from "./types.ts";

export const themes: readonly InteriorTheme[] = [office];
export const matchesTheme = (label: string, match: string): boolean => {
	const name = label.toLowerCase();
	return name === match || name.startsWith(`${match}-`);
};
export function themeFor(label: string): InteriorTheme {
	return (
		themes.find((t) => t.match.some((m) => matchesTheme(label, m))) ?? office
	);
}
