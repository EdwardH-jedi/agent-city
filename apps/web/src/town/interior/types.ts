import type { Session } from "@agent-city/schema";
import type { VillageModel } from "../../board/model.ts";
import type { TailEvent } from "../../board/tail.ts";

/** Already-held board data; the room has no way to request anything. */
export interface InteriorSource {
	model: VillageModel;
	sessions: readonly Session[];
	events: readonly TailEvent[];
	now: number;
}
export interface InteriorNotice {
	repo_id: string;
	label: string;
}
