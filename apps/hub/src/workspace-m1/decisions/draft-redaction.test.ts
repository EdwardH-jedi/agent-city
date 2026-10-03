// F-01 regression: the mutable workspace draft is redacted BEFORE it is stored (create + save), so no
// surface (DB column, task view, detail, snapshot, read-only principal, after publish) ever holds a
// raw secret. Canaries are assembled at runtime (check:secrets scans files).
import { afterEach, describe, expect, test } from "bun:test";
import {
	PROPOSAL_CONTRACT_V1_2,
	ProposalDraft,
	proposalCriteriaTexts,
	WorkspaceTaskView,
} from "@agent-city/schema/workspace-m1";
import { buildProposalSnapshotV1_2 } from "@agent-city/schema/workspace-m1/hash";
import { storedDraft } from "./commands.ts";
import {
	draft,
	dump,
	type Env,
	expectOk,
	key,
	makeEnv,
	publish,
} from "./test-support.ts";

const envs: Env[] = [];
afterEach(() => {
	for (const e of envs.splice(0)) e.fx.cleanup();
});

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const rnd = (n: number) =>
	Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) =>
		ALNUM.charAt(b % ALNUM.length),
	).join("");

/** Three synthetic secret shapes: a token format, an assignment, a YAML block body. */
function canaries() {
	const token = `gh${"p_"}${rnd(36)}`;
	const assigned = `v${rnd(24)}`;
	const block = `b${rnd(30)}`;
	const d = draft({
		title: `Rotate ${token}`,
		objective: `Replace the old key.\npass${"word"}=${assigned}\napi_${"key"}: |\n  ${block}\nthen verify.`,
		criteria: ["The fixture check passes", `tok${"en"}=${assigned} is gone`],
	});
	return { d, all: [token, assigned, block] };
}

const holds = (text: string, needles: string[]) =>
	needles.some((n) => text.includes(n));

describe("F-01 draft redaction", () => {
	test("create: no surface holds a raw secret (DB, response, detail, snapshot, read-only principal)", async () => {
		const e = makeEnv();
		envs.push(e);
		const s = await e.login();
		const { d, all } = canaries();
		const res = await e.request("POST", "/tasks", s, {
			idempotency_key: key(),
			repo_id: e.fx.repoId,
			draft: d,
		});
		expect(res.status).toBe(201);
		const text = await res.text();
		const view = WorkspaceTaskView.parse(JSON.parse(text));
		expect(holds(text, all)).toBe(false);
		expect(view.task.draft.title).toContain("[REDACTED]");
		expect(view.task.draft.objective).toContain("[REDACTED]");
		expect(view.task.draft.criteria[1]).toContain("[REDACTED]");
		expect(view.task.draft.criteria[0]).toBe("The fixture check passes");
		const column = JSON.stringify(
			e.db.query("SELECT draft FROM workspace_tasks").all(),
		);
		expect(holds(column, all)).toBe(false);
		const viewer = await e.login(e.readOnlyCredential);
		for (const sess of [s, viewer])
			for (const path of ["/snapshot", `/tasks/${view.task.id}`]) {
				const r = await e.request("GET", path, sess);
				expect(r.status).toBe(200);
				expect(holds(await r.text(), all)).toBe(false);
			}
		expect(holds(dump(e.db), all)).toBe(false);
	});

	test("save: the stored and returned draft is redacted; publish freezes byte-identical text", async () => {
		const e = makeEnv();
		envs.push(e);
		const s = await e.login();
		const v = await e.ctx(s);
		const created = expectOk(
			e.services.commands.createTask(
				v,
				{ idempotency_key: key(), repo_id: e.fx.repoId, draft: draft() },
				e.tick(),
			),
		);
		const { d, all } = canaries();
		const saved = await e.request("PUT", `/tasks/${created.task.id}/draft`, s, {
			expected_rev: created.task.rev,
			draft: d,
		});
		expect(saved.status).toBe(200);
		expect(holds(await saved.clone().text(), all)).toBe(false);
		const stored = e.store.getTask(created.task.id)?.draft;
		expect(stored).toBeDefined();
		expect(holds(JSON.stringify(stored), all)).toBe(false);

		const { view } = await publish(e, v, created.task.id);
		const snap = view.current_proposal?.snapshot;
		if (!snap || !stored) throw new Error("no snapshot");
		// frozen text = the stored (already redacted) draft, trimmed — nothing new is masked
		expect(snap.title).toBe(stored.title.trim());
		expect(snap.objective).toBe(stored.objective.trim());
		expect(snap.contract).toBe(PROPOSAL_CONTRACT_V1_2);
		expect(proposalCriteriaTexts(snap)).toEqual(
			stored.criteria.map((c) => c.trim()),
		);
		// and byte-identical to freezing the RAW draft directly (redact is idempotent)
		const fromRaw = buildProposalSnapshotV1_2({
			proposal_id: snap.proposal_id,
			workspace_task_id: snap.workspace_task_id,
			version: snap.version,
			predecessor_proposal_id: snap.predecessor_proposal_id,
			repo_id: snap.repo_id,
			base_ref: snap.base_ref,
			base_sha: snap.base_sha,
			required_checks: snap.verification_plan.required_checks,
			draft: ProposalDraft.parse(d),
		});
		if (!fromRaw.ok) throw new Error("raw draft did not freeze");
		expect(fromRaw.snapshot as unknown).toEqual(snap);
		// after publish the draft stays redacted and nothing anywhere holds a canary
		expect(holds(JSON.stringify(e.store.getTask(created.task.id)), all)).toBe(
			false,
		);
		expect(holds(dump(e.db), all)).toBe(false);
		const detail = await e.request("GET", `/tasks/${created.task.id}`, s);
		expect(holds(await detail.text(), all)).toBe(false);
	});

	test("idempotent create compares the redacted form: same raw body replays, a different body conflicts", async () => {
		const e = makeEnv();
		envs.push(e);
		const v = await e.ctx();
		const { d } = canaries();
		const k = key("redacted");
		const body = { idempotency_key: k, repo_id: e.fx.repoId, draft: d };
		const first = e.services.commands.createTask(v, body, e.tick());
		expect(first.status).toBe(201);
		const again = e.services.commands.createTask(
			v,
			structuredClone(body),
			e.tick(),
		);
		expect(again.status).toBe(200);
		expect(expectOk(again).task.id).toBe(expectOk(first).task.id);
		const other = e.services.commands.createTask(
			v,
			{ ...body, draft: { ...d, objective: `${d.objective} More.` } },
			e.tick(),
		);
		expect(other.status).toBe(409);
		expect((other.body as { error: string }).error).toBe(
			"idempotency_conflict",
		);
		// a body differing ONLY inside a masked secret is the same stored request (as OQ-3)
		const sameMasked = canaries().d;
		expect(storedDraft(sameMasked)).toEqual(storedDraft(d));
		expect(
			e.services.commands.createTask(
				v,
				{ ...body, draft: sameMasked },
				e.tick(),
			).status,
		).toBe(200);
		expect(e.store.listTasks().length).toBe(1);
	});

	test("redaction that pushes a field past its bound → 400 invalid_request with issues, never truncated", async () => {
		const e = makeEnv();
		envs.push(e);
		const v = await e.ctx();
		// 10 × "password=x " = 110 chars ≤ 120; each grows to "password=[REDACTED]" → over 120
		const long = Array.from({ length: 10 }, () => `pass${"word"}=x`).join(" ");
		expect(long.length).toBeLessThanOrEqual(120);
		const res = e.services.commands.createTask(
			v,
			{
				idempotency_key: key(),
				repo_id: e.fx.repoId,
				draft: draft({ title: long }),
			},
			e.now(),
		);
		expect(res.status).toBe(400);
		expect((res.body as { error: string }).error).toBe("invalid_request");
		expect(
			((res.body as { issues?: { path: string }[] }).issues ?? []).map(
				(i) => i.path,
			),
		).toContain("title");
		expect(e.store.listTasks().length).toBe(0);

		const created = expectOk(
			e.services.commands.createTask(
				v,
				{ idempotency_key: key(), repo_id: e.fx.repoId, draft: draft() },
				e.tick(),
			),
		);
		const snapshot = dump(e.db);
		const save = e.services.commands.saveDraft(
			v,
			created.task.id,
			{ expected_rev: created.task.rev, draft: draft({ title: long }) },
			e.now(),
		);
		expect(save.status).toBe(400);
		expect(dump(e.db)).toBe(snapshot);
	});
});
