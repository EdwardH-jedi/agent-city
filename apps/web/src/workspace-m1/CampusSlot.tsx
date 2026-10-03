// Lead-owned mount of the business-campus presentation (campus/**) — shared by Projects and HQ.
import { useLayoutEffect, useMemo, useRef } from "react";
import { createCampusActions } from "./campus/actions.ts";
import { CampusView } from "./campus/CampusView.tsx";
import { toCampusModel } from "./campus/presentation.ts";
import { useWs } from "./parts.tsx";

/**
 * The business-campus presentation (campus/**): a read-only model of the server-backed store state
 * plus selection-only intents (select repo / select task / open an approval document). It never
 * decides, queues, advances, cancels or accepts anything; the DOM navigator below stays usable while
 * the WebGL scene loads or when it is unavailable.
 */
export function Campus() {
	const { store, state } = useWs();
	const model = useMemo(() => toCampusModel(state), [state]);
	const latest = useRef(model);
	useLayoutEffect(() => {
		latest.current = model;
	});
	const actions = useMemo(
		() =>
			createCampusActions(
				(r) => store.navigate(r),
				() => latest.current,
			),
		[store],
	);
	return (
		<div className="wsm1-campus-slot">
			<CampusView model={model} actions={actions} />
		</div>
	);
}
