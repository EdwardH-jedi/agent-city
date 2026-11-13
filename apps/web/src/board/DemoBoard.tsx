// `?demo=1`: the board over made-up data (demo.ts). Loaded lazily by App only on that URL, so the live
// bundle carries no fixture (§13.9). Nothing is fetched and nothing sounds.
import { useMemo, useState } from "react";
import { BoardView, useClock } from "./Board.tsx";
import { demoCaseOf, demoData } from "./demo.ts";
import { toVillageModel } from "./model.ts";

export default function DemoBoard() {
	const now = useClock(1_000);
	const [t0] = useState(() => Date.now());
	const [kase] = useState(() => demoCaseOf(window.location.search));
	const data = useMemo(() => demoData(t0, kase), [t0, kase]);
	const model = useMemo(
		() => toVillageModel({ ...data, now, conn: "open" }),
		[data, now],
	);
	return (
		<BoardView
			model={model}
			now={now}
			reconnecting={false}
			error={null}
			demo={true}
			sessions={data.sessions}
			events={data.events}
			runs={data.runs}
			usage={data.usage}
		/>
	);
}
