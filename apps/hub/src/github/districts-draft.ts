// `bun run districts:draft` — write config/districts.draft.yaml from the repos in the DB.
// Never touches config/districts.yaml. Run `bun run sync:github` first.
import { openDb } from "../db.ts";
import {
	DISTRICTS_DRAFT_PATH,
	loadDistricts,
	renderDistrictsDraft,
} from "./districts.ts";

const db = openDb(process.env.DB_PATH || "./data/agentcity.db");
const rows = db
	.query<{ id: string; is_local_only: number }, []>(
		"SELECT id, is_local_only FROM repos",
	)
	.all();
if (rows.length === 0) {
	console.error(
		"[districts:draft] no repos in the DB — run `bun run sync:github` first",
	);
	process.exit(1);
}

// District comes from the current districts.yaml, so edits there show up without a re-sync.
const districts = loadDistricts();
const repos = rows.map((r) => ({
	id: r.id,
	district: districts.districtOf(r.id),
	is_local_only: r.is_local_only === 1,
}));
await Bun.write(
	DISTRICTS_DRAFT_PATH,
	renderDistrictsDraft(repos, districts.names, new Date().toISOString()),
);

const counts = new Map<string, number>();
for (const r of repos)
	counts.set(r.district, (counts.get(r.district) ?? 0) + 1);
console.log(`[districts:draft] wrote ${DISTRICTS_DRAFT_PATH}`);
for (const name of districts.names) {
	console.log(`  ${name.padEnd(14)} ${counts.get(name) ?? 0}`);
}
for (const w of districts.warnings) console.log(`  warning: ${w}`);
