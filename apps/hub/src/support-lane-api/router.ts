// Support-job HTTP routes, mounted inside the workspace API (`/api/workspace`) AFTER `auth.install` and BEFORE the
// workspace router, so the workspace guard runs first: a session for everything, `workspace:read` for GET, and for
// every other method the exact Origin, the CSRF header and `workspace:decide`. These routes record and show
// read-only informational jobs; none starts one, assigns a worker, touches Git, a managed task, a proposal or either
// Gate. Every response is validated with its schema before it is sent and carries `cache-control: no-store`.
//
//   GET  /support-jobs?repo_id&status&limit&cursor → SupportJobPage (newest first, keyset-paged, ≤ 100)
//   GET  /support-jobs/:id                         → SupportJobView
//   POST /support-jobs        {idempotency_key, job} → SupportJobView, 201 | 200 replay | 409 idempotency_conflict
//   POST /support-jobs/:id/cancel {expected_rev}   → SupportJobView (cancellation intent)
import type { Database } from "bun:sqlite";
import {
	IdempotencyKey,
	type OperatorPrincipal,
	PageMeta,
	type VerifiedAuthContext,
	WORKSPACE_ERROR_STATUS,
	type WorkspaceErrorCode,
} from "@agent-city/schema/workspace-m1";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { ManagedConfig } from "../managed/config.ts";
import { parseGuarded } from "../support-jobs/guards.ts";
import {
	SupportJob,
	SupportJobRequest,
	SupportJobStatus,
	SupportRepoId,
} from "../support-jobs/job.ts";
import { createSupportJobStore, type SupportJobRecord } from "./store.ts";

export const SUPPORT_ROUTES = {
	jobs: "/support-jobs",
	job: "/support-jobs/:id",
	cancel: "/support-jobs/:id/cancel",
} as const;

export const SUPPORT_PAGE_MAX = 100;
export const SUPPORT_PAGE_DEFAULT = 50;

export const SupportJobView = z.strictObject({
	job: SupportJob,
	rev: z.int().min(1),
	updated_at: z.iso.datetime(),
});
export type SupportJobView = z.infer<typeof SupportJobView>;

export const SupportJobPage = z.strictObject({
	repo_id: SupportRepoId.nullable(),
	status: SupportJobStatus.nullable(),
	items: z.array(SupportJobView).max(SUPPORT_PAGE_MAX),
	page: PageMeta,
});
export type SupportJobPage = z.infer<typeof SupportJobPage>;

const CreateBody = z.strictObject({
	idempotency_key: IdempotencyKey,
	job: z.unknown(),
});
const CancelBody = z.strictObject({
	expected_rev: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
});
const ListQuery = z.strictObject({
	repo_id: SupportRepoId.optional(),
	status: SupportJobStatus.optional(),
	limit: z
		.string()
		.regex(/^[1-9]\d{0,2}$/)
		.transform(Number)
		.refine((n) => n <= SUPPORT_PAGE_MAX)
		.default(SUPPORT_PAGE_DEFAULT),
	cursor: z.string().max(512).optional(),
});
/** A cursor names its scope; it is refused (400) for any other scope and grants nothing. */
const SupportCursor = z.strictObject({
	v: z.literal(1),
	feed: z.literal("support"),
	repo: SupportRepoId.nullable(),
	status: SupportJobStatus.nullable(),
	limit: z.int().min(1).max(SUPPORT_PAGE_MAX),
	seq: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
});
type SupportCursor = z.infer<typeof SupportCursor>;

const encodeCursor = (c: SupportCursor): string =>
	Buffer.from(JSON.stringify(c)).toString("base64url");

function readCursor(
	raw: string | undefined,
	scope: Omit<SupportCursor, "seq">,
): SupportCursor | null | "invalid" {
	if (raw === undefined) return null;
	if (!/^[A-Za-z0-9_-]{1,512}$/.test(raw)) return "invalid";
	let json: unknown;
	try {
		json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
	} catch {
		return "invalid";
	}
	const c = SupportCursor.safeParse(json);
	if (!c.success) return "invalid";
	const d = c.data;
	return d.repo === scope.repo &&
		d.status === scope.status &&
		d.limit === scope.limit
		? d
		: "invalid";
}

export interface SupportRouterDeps {
	/** The workspace auth instance (its guard is installed before this router). */
	auth: {
		verified(c: Context): VerifiedAuthContext | null;
		principal(c: Context): OperatorPrincipal | null;
	};
	db: Database;
	config: ManagedConfig;
	clock?: { now(): Date };
	max_body_bytes?: number;
}

const HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
} as const;

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: HEADERS });

const error = (
	code: WorkspaceErrorCode,
	issues?: readonly string[],
): Response =>
	json(WORKSPACE_ERROR_STATUS[code], {
		error: code,
		...(issues?.length ? { issues: issues.slice(0, 20) } : {}),
	});

/** Fixed body: an unexpected failure (incl. a stored row that no longer validates) discloses nothing. */
const internal = (): Response => json(500, { error: "internal error" });

/** Contract-validate a response body (fail closed: an invalid body is never sent). */
function respond<S extends z.ZodType>(
	status: number,
	schema: S,
	value: unknown,
): Response {
	const r = schema.safeParse(value);
	return r.success ? json(status, r.data) : internal();
}

const view = (r: SupportJobRecord): SupportJobView => ({
	job: r.job,
	rev: r.rev,
	updated_at: r.updated_at,
});

export function createSupportJobRouter(deps: SupportRouterDeps): Hono {
	const store = createSupportJobStore(deps.db);
	const now = () => (deps.clock ? deps.clock.now() : new Date());
	const maxBody = deps.max_body_bytes ?? 64 * 1024;
	const allowed = new Set(deps.config.repos.map((r) => r.id));
	const r = new Hono();

	const safely =
		(fn: (c: Context) => Promise<Response> | Response) =>
		async (c: Context): Promise<Response> => {
			try {
				return await fn(c);
			} catch {
				return internal();
			}
		};

	async function body(c: Context): Promise<unknown | Response> {
		let text: string;
		try {
			text = await c.req.text();
		} catch {
			return error("invalid_request");
		}
		if (Buffer.byteLength(text, "utf8") > maxBody)
			return error("payload_too_large");
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return error("invalid_request");
		}
	}

	r.get(
		SUPPORT_ROUTES.jobs,
		safely((c) => {
			if (!deps.auth.principal(c)) return internal(); // guard not installed: wiring fault
			const params = new URL(c.req.url).searchParams;
			const raw: Record<string, string> = {};
			for (const [k, v] of params) {
				if (Object.hasOwn(raw, k)) return error("invalid_request");
				raw[k] = v;
			}
			const q = ListQuery.safeParse(raw);
			if (!q.success) return error("invalid_request");
			const repo = q.data.repo_id ?? null;
			if (repo !== null && !allowed.has(repo)) return error("repo_not_allowed");
			const scope = {
				v: 1 as const,
				feed: "support" as const,
				repo,
				status: q.data.status ?? null,
				limit: q.data.limit,
			};
			const cursor = readCursor(q.data.cursor, scope);
			if (cursor === "invalid") return error("invalid_request");
			const page = store.list({
				repo_id: repo,
				status: scope.status,
				limit: scope.limit,
				before_seq: cursor?.seq ?? null,
			});
			const last = page.records.at(-1);
			return respond(200, SupportJobPage, {
				repo_id: repo,
				status: scope.status,
				items: page.records.map(view),
				page: {
					total: page.total,
					returned: page.records.length,
					complete:
						cursor === null &&
						!page.has_more &&
						page.records.length === page.total,
					has_more: page.has_more,
					next_cursor:
						page.has_more && last
							? encodeCursor({ ...scope, seq: last.job.created_seq })
							: null,
					as_of: now().toISOString(),
				},
			});
		}),
	);

	r.get(
		SUPPORT_ROUTES.job,
		safely((c) => {
			if (!deps.auth.principal(c)) return internal();
			const rec = store.get(c.req.param("id") ?? "");
			return rec ? respond(200, SupportJobView, view(rec)) : error("not_found");
		}),
	);

	r.post(
		SUPPORT_ROUTES.jobs,
		safely(async (c) => {
			const v = deps.auth.verified(c);
			if (!v) return internal();
			const b = await body(c);
			if (b instanceof Response) return b;
			const parsed = CreateBody.safeParse(b);
			if (!parsed.success) return error("invalid_request");
			// the request's normalized repository must be on the trusted allowlist (as for workspace tasks)
			const request = parseGuarded(SupportJobRequest, parsed.data.job);
			if (!request.ok) return error("invalid_request", request.issues);
			if (!allowed.has(request.data.repo_id)) return error("repo_not_allowed");
			const out = store.create({
				created_by: v.principal.operator_id,
				idempotency_key: parsed.data.idempotency_key,
				request: parsed.data.job,
				now: now(),
			});
			if (!out.ok)
				return out.error === "invalid_request"
					? error("invalid_request", out.issues)
					: error("idempotency_conflict");
			return respond(out.created ? 201 : 200, SupportJobView, view(out.record));
		}),
	);

	r.post(
		SUPPORT_ROUTES.cancel,
		safely(async (c) => {
			const v = deps.auth.verified(c);
			if (!v) return internal();
			const b = await body(c);
			if (b instanceof Response) return b;
			const parsed = CancelBody.safeParse(b);
			if (!parsed.success) return error("invalid_request");
			const out = store.cancel(
				c.req.param("id") ?? "",
				parsed.data.expected_rev,
				now(),
			);
			return out.ok
				? respond(200, SupportJobView, view(out.record))
				: error(out.error);
		}),
	);

	return r;
}
