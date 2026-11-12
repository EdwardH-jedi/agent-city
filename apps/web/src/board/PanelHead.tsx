// A panel section's head strip (design doc 15 §2, the original's `.m32-head` / `.tui-panel-head`): a Latin
// upper-case title (`MAP`, `HQ`, `PAUSED`, `LOG`, `SESSIONS`) and, beside it, a dim Korean note with the
// counts (`대기 2 · Mac에서 처리`). The title is always DOM text; while the town runs it is also drawn in
// the town's pixel font (town/pixel-title.tsx, lazy) and the DOM word steps out of sight but stays for
// screen readers. The head keeps one height either way, so nothing moves when the pixel title arrives.
import type { ReactNode } from "react";
import { TownPixelWord } from "../town/TownView.tsx";

export const PANEL_TITLES = [
	"MAP",
	"HQ",
	"PAUSED",
	"LOG",
	"SESSIONS",
	// the detail screen (16 A3)
	"RUNS",
	"REPOS",
	"EVENTS",
] as const;
export type PanelTitle = (typeof PANEL_TITLES)[number];

export function PanelHead({
	title,
	label,
	sub,
	pixel,
}: {
	title: PanelTitle;
	/** What the section is, in Korean (`HQ 대기`; the section's own aria-label says it too). */
	label: string;
	sub?: ReactNode;
	/** Draw the title in the town's pixel font (the town scene). */
	pixel: boolean;
}) {
	return (
		<div className="phead">
			<h2 className="ptitle" title={label}>
				<span className="ptitle-text">{title}</span>
				{pixel && <TownPixelWord text={title} />}
			</h2>
			{sub != null && <span className="psub">{sub}</span>}
		</div>
	);
}
