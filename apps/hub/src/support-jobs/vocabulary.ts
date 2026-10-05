// Support-lane capability vocabulary — the ONE local swap point.
//
// A support job asks for an abstract capability (how much model it needs), never a concrete model
// (Haiku, a lightweight OpenAI model, a local model…). Resolving a capability to a worker profile is
// the job of a future router built on the canonical Worker Profile Registry; until that lands, these
// two small types stand in for it. The integrator replaces this file's exports with the canonical
// types — nothing else in support-jobs/ spells capability or profile values directly.
import { z } from "zod";

/** FAST = cheap, high-volume read-only work; STANDARD = needs a stronger (still read-only) model. */
export const SUPPORT_CAPABILITIES = ["FAST", "STANDARD"] as const;

export const SupportCapability = z.enum(SUPPORT_CAPABILITIES);
export type SupportCapability = z.infer<typeof SupportCapability>;

/**
 * A resolved worker profile id, assigned only by a future router (never by the requester).
 * Opaque, lowercase, bounded — it names a profile, it is not a model name or a credential.
 */
export const SupportProfileId = z
	.string()
	.regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "profile id");
export type SupportProfileId = z.infer<typeof SupportProfileId>;
