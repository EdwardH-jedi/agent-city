// Support-lane capability vocabulary — the canonical Worker Profile types, narrowed to this lane.
//
// A support job asks for an abstract capability (how much model it needs), never a concrete model
// (Haiku, a lightweight OpenAI model, a local model…). The values are the canonical Worker Profile
// tiers (`WorkerCapabilityTier` in @agent-city/schema), restricted to the two a read-only support
// job may request; resolving one to a worker profile is the router's job (see
// apps/hub/src/model-factory/). Nothing else in support-jobs/ spells capability or profile values.
import { WorkerCapabilityTier, WorkerProfileId } from "@agent-city/schema";

/** fast = cheap, high-volume read-only work; standard = needs a stronger (still read-only) model. */
export const SupportCapability = WorkerCapabilityTier.extract([
	"fast",
	"standard",
]);
export type SupportCapability = (typeof SupportCapability)["options"][number];

export const SUPPORT_CAPABILITIES: readonly SupportCapability[] =
	SupportCapability.options;

/**
 * A resolved worker profile id (canonical `WorkerProfileId`), assigned only by a future router
 * (never by the requester). It names a profile; it is not a model name or a credential.
 */
export const SupportProfileId = WorkerProfileId;
export type SupportProfileId = WorkerProfileId;
