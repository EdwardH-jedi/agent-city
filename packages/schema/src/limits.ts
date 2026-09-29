// Limits shared by collectors and the hub. zod-free (the Claude hook imports this via ./core).

/** Most events in one POST /ingest (F15). Collectors send in chunks of exactly this size. */
export const MAX_INGEST_BATCH = 500;
