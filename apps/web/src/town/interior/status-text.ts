import { redact } from "@agent-city/schema";
import type { VillageModel } from "../../board/model.ts";

export const PHASE_TEXT = [
	"GOAL",
	"PLAN",
	"APPROVAL",
	"IMPL",
	"QA",
	"REVIEW",
	"INTEGRATE",
	"CLEANUP",
	"REPORT",
] as const;
/** Only the existing project's label, bounded and redacted; no branch, cwd or raw status code. */
export const interiorLabel = (label: string): string =>
	redact(label)
		.toUpperCase()
		.replace(/[^A-Z0-9 _-]/g, " ")
		.trim()
		.slice(0, 40) || "PROJECT";

export function statusText(model: VillageModel, repo: string): string {
	const p = model.village.shown.find((r) => r.id === repo);
	if (!p) return "";
	const sign = model.visits
		.filter(
			(v) =>
				v.project_id === repo &&
				v.kind === "sign" &&
				!v.id.startsWith("session:"),
		)
		.at(-1);
	if (sign) return sign.carry === "binder" ? "HOLD" : "WAIT";
	const run = model.now
		.filter((r) => r.project_id === repo && r.kind === "run")
		.at(-1);
	if (run)
		return (
			PHASE_TEXT[run.phase_index] ?? `ACTIVE ${p.sessions} WAIT ${p.waiting}`
		);
	if (model.paused.some((r) => r.project_id === repo)) return "PAUSED";
	return interiorLabel(p.label);
}
