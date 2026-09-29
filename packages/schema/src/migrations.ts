// Bun-only entry (uses import.meta.dir) — keep out of index.ts so the web app can import types.
import { join } from "node:path";

export const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");
