# Workspace M1 auth (role 03) — notes

Scope: `apps/hub/src/workspace-m1/auth/` only. Everything else below is a **proposal** for the lead.
Contracts used unchanged: `decision.ts` (OperatorPrincipal, SessionView, CSRF_HEADER, ChallengeBinding,
CHALLENGE_TTL_MS, error codes), `ports.ts` (VerifiedAuthContext, ChallengePort, WorkspaceTx), `api.ts`
(WORKSPACE_API_BASE, SignInRequest), `hash.ts` (newBootId, newToken256, challengeHash, challengeValid).

## Files

| File | Role |
| --- | --- |
| `config.ts` | `WorkspaceAuthOptions`, validation + clamps, credential → sha256 digest (raw value not kept) |
| `sessions.ts` | in-memory `SessionStore` (boot id, generation counter, rotation, caps, absolute + idle expiry) |
| `http.ts` | fixed error bodies, hardening headers, strict cookie parse/serialize, exact JSON content-type, body limit |
| `auth.ts` | `createWorkspaceAuth` — guard middleware, `/session` routes, context minting, `install` |
| `challenges.ts` | `WorkspaceChallenges implements ChallengePort`, `ChallengePortError` |
| `index.ts` | public surface |
| `test-support.ts` | test-only: fake clock, fake `WorkspaceTx`, run-request row builder, guarded stub app |
| `*.test.ts` | 77 tests (HTTP guard, ChallengePort, config) |

## API

```ts
const auth = createWorkspaceAuth({
  operator_credential,            // ≥ 32 visible ASCII chars, per run; absent/invalid → disabled (503)
  allowed_origin: "http://127.0.0.1:5173", // exact URL.origin form
  // optional: extra_allowed_origins, session_ttl_ms (≤ 12 h, default 8 h), idle_timeout_ms (≤ ttl,
  // default 30 min), challenge_ttl_ms (≤ 300 s, default 300 s), max_sessions_per_principal (1..16,
  // default 4), max_body_bytes (1 KiB..1 MiB, default 64 KiB), base_path (default /api/workspace),
  // clock { now(): Date }, read_only_credential (TESTS ONLY, R-A5)
});
auth.enabled; auth.disabled_reason  // fixed text, safe to log, never contains a credential
auth.install(workspaceSubApp)       // guard + GET/POST/DELETE /session — call BEFORE adding any route
auth.verified(c)  : VerifiedAuthContext | null   // mutations only, after all checks; frozen; per request
auth.principal(c) : OperatorPrincipal | null     // any authenticated request (reads too)
auth.challenges   : WorkspaceChallenges (ChallengePort)
auth.revokeAllSessions(); auth.boot_id; auth.settings (non-secret effective settings)
```

**Order** (every request under the mount; frozen OQ-1): body limit `413 payload_too_large` →
session cookie `401 unauthenticated` → exact Origin `403 forbidden_origin` → CSRF header on mutations
`403 csrf_invalid` → scope `403 forbidden_scope` → JSON content-type on bodies `415
unsupported_media_type` → route. Sign-in (`POST <base>/session`): body limit (4 KiB) → exact Origin
(required) → content-type → strict `SignInRequest` (`400 invalid_request`) → constant-time credential
compare (`401`, no `Set-Cookie`). Reads = GET/HEAD (`workspace:read`); `DELETE /session` = mutation
with `workspace:read`; every other method = mutation with `workspace:decide`. Disabled → `503
disabled` for everything. Error bodies are `{error, message}` with fixed messages; nothing echoed.
Every response carries `cache-control: no-store`, `x-content-type-options: nosniff`,
`cross-origin-resource-policy: same-origin`.

**Origin**: `allowed_origins.has(header)` — exact string, no parsing of the presented value, so
`null`, `localhost` vs `127.0.0.1`, other ports, scheme, case, trailing slash, path, userinfo, comma
lists and duplicate headers (Fetch joins them with `", "`) all fail. GET without Origin is allowed
(R-A10) **unless** `Sec-Fetch-Site` is present and not `same-origin`/`none` (additive tightening for
no-cors cross-port loads; applied only when Origin is absent, so an exact extra origin on another
port still works).

**Sessions**: opaque 32-byte cookie `agentcity_ws_session` (`HttpOnly; SameSite=Strict;
Path=/api/workspace; Max-Age=<ttl>`, `Secure` iff the primary origin is `https:` — R-N7, no Domain);
only sha256(cookie) is stored. Sign-in revokes the session named by the presented cookie (rotation;
a chosen value can never become valid) and evicts the principal's oldest sessions beyond the cap.
Each sign-in gets a new `session_generation`; each auth instance a new `boot_id` → restart kills all
sessions and challenges with no write. Idle clock refreshed only by requests that pass every check.
`SessionView.expires_at` = min(absolute, last activity + idle). Duplicate/malformed cookies → 401.

**ChallengePort** (`challenges.ts`), both in-tx, using only the `now` argument:
- `issue(tx, row, auth, now)` → requires a context minted by this instance whose session is live at
  `now`, `workspace:decide`, `row.status = pending`; CAS `updateApprovalRequest(row.id, row.rev, …)`
  writes `challenge_status=issued`, `challenge_hash = H(ChallengeBinding{token, id, kind, binding_hash,
  request_rev = row.rev+1, operator_id, session_generation, boot_id, expires_at})` and the bound
  fields; returns `ChallengeIssueResponse` (token once). Supersedes any earlier challenge. Failures
  **throw** `ChallengePortError(code)` with `unauthenticated | forbidden_scope | invalid_state |
  stale_binding` (the port type has no failure variant; the throw rolls the tx back). A store that does
  not bump rev by exactly 1 → plain `Error` (rollback).
- `verifyAndConsume(tx, row, presented, auth, now)` → explicit checks (context minted + live, decide
  scope, pending, status issued, boot/operator/generation equal, `challenge_request_rev === row.rev`,
  window ≤ configured TTL) + `challengeValid` (hash recompute, constant-time, `now < expires_at`).
  Any failure → `{ok:false, code:"challenge_invalid"}` and **no write** (R-A2). Success → CAS consume
  (`challenge_status=consumed`) → `{ok:true, request: <row at rev+1>}` (extra field; through the
  plain port type re-read with `tx.getApprovalRequest`). A CAS miss on the consume = caller passed a
  stale row → `challenge_invalid`, nothing written.
- **Rev arithmetic for 04**: decision tx loads row at `r = challenge_request_rev` (= the client's
  `expected_request_rev`); consume → `r+1`; 04's status update must CAS at `r+1` → `r+2` (receipt rev).
  Call `verifyAndConsume` **before any other write to the request row** in the decision tx: any earlier
  write bumps rev, and `challenge_request_rev === row.rev` then makes the challenge `challenge_invalid`.
- 04 must compare the client's `kind/binding_hash/expected_request_rev` with the row before `issue`
  (UX only — a challenge always binds the row's *current* binding/rev, and the decision re-checks).
- Nothing in middleware touches challenges, so a same-key retry reaches 04's receipt lookup first.
- 04 must **throw** (not return) on any failure after `verifyAndConsume` succeeded, so the consume
  rolls back with the rest of the transaction.

## Threat assumptions

Local, single-user, loopback hub; attacker = another web page/process on any loopback port or a
foreign site, without the per-run credential. Other loopback ports are **same-site**: SameSite=Strict
does not stop them from *sending* the cookie (L-09) — exact Origin + CSRF stop mutations; no
credentialed CORS + `CORP: same-origin` + `nosniff` stop reading. Not defended: a privileged local
attacker reading hub memory, the process environment, the launcher's credential, the DB or
artifacts; malicious browser extensions; remote/production deployment (not claimed).

## Contract collisions / notes for 08, 09, 04 (no contract edited)

1. `OperatorId` is the literal `operator:edward`, so the read-only test principal is
   `operator:edward` with `scopes:["workspace:read"]` (distinguished by credential). Harness
   `login("operator:viewer")` should map to `read_only_credential`. Safe for ADV-IDEM-06: the read-only
   principal gets `403 forbidden_scope` before any receipt lookup. A distinct id needs a v1.x delta.
2. ADV-AUTH-09 "replay of a used bootstrap credential": the per-run credential is **reusable** by
   design (re-login after logout/expiry/restart); not single-use. Not a defect.
3. ADV-ORIGIN-06 padded `" O"`: Fetch/HTTP strip optional whitespace around header values (RFC 9110
   §5.5), so it *is* `O` and is accepted (tested). Not distinguishable, not a bypass.
4. ADV-CHAL-06/09 propose `challenge_expired`/`challenge_consumed`; frozen §7 has one code,
   `409 challenge_invalid`, for every failure.
5. ADV-CSRF-03 / ADV-CHAL-08 need two live sessions of one principal: default cap is 4. Set
   `max_sessions_per_principal: 1` to make every sign-in revoke the principal's other sessions.
6. All mutations need `Origin` — including sign-in. Non-browser harness clients must send it.

## Lead-owned patch proposals (not applied)

**P1 mount** — new `apps/hub/src/routes/workspace.ts` (lead):
```ts
const ws = new Hono();
auth.install(ws);                 // FIRST: a route registered before install is NOT guarded (tested)
ws.get("/snapshot", …); ws.post("/approval-requests/:id/challenge", …); /* 04/02/05/06 routes */
// in handlers: const v = auth.verified(c); if (!v) return 500 (fail closed) — never build one
```
`base_path` (default `WORKSPACE_API_BASE`) **must equal the mount prefix**: if they differ, `POST
/session` is treated as an ordinary guarded route and sign-in is impossible (fails closed, looks like a
broken login). `createApp` (`apps/hub/src/index.ts`): `app.route(WORKSPACE_API_BASE, ws)` **before**
`app.route("/api", createApi(db))`; when workspace mode is off, mount a 503 stub (`createWorkspaceAuth({})`
is already disabled → `install` gives 503 for every path). Log `auth.disabled_reason` (fixed text).

**P2 corsGuard** (`apps/hub/src/security.ts`): it echoes `access-control-allow-origin` for any
loopback port and answers `OPTIONS` 204. Skip workspace paths entirely (UI is same-origin via proxy):
```ts
export function corsGuard(cfg: SecurityConfig, exempt = "/api/workspace"): MiddlewareHandler {
	return async (c, next) => {
		const p = c.req.path;
		if (p === exempt || p.startsWith(`${exempt}/`)) return next(); // workspace: no CORS at all
		…unchanged…
```
(ADV-ORIGIN-10/11: no ACAO, preflight then reaches the guard → 401.)

**P3 hub option + env** (`HubOptions`/`startHub`, `import.meta.main`): `workspace?: WorkspaceAuthOptions`
(plus the other roles' deps). Env (blank by default, never logged): `WORKSPACE_OPERATOR_CREDENTIAL`
(empty → workspace disabled), `WORKSPACE_ALLOWED_ORIGIN` (e.g. `http://127.0.0.1:5173`, the Vite origin;
the Vite proxy forwards `Origin` unchanged), optional `WORKSPACE_SESSION_TTL_MIN`,
`WORKSPACE_IDLE_TIMEOUT_MIN`. Rows for `.env.example` (blank values) and the README env table
(docs-parity test). **No env var for `read_only_credential`** — harness option only.

**P4 harness** (08/09): generate both credentials with `randomBytes`; pass `clock`; `restart()` = new
`createWorkspaceAuth` (new boot); BRW-R-28 → `auth.revokeAllSessions()`; `login()` sends exact Origin
+ JSON and reads the CSRF token from the body, the cookie from `Set-Cookie` (never printed).

**P5 legacy surfaces**: `/api/managed/*` → 410 in workspace mode (R-A6; its current guard accepts
any-port loopback Origins and only checks Origin when present). `/ws`: L4 already applied (no managed
broadcast); `checkWsRequest` still accepts absent Origin and any loopback port — acceptable only while
`/ws` stays observed-telemetry-only; a future private channel needs cookie + exact Origin + a
CSRF-equivalent first message. Telemetry `/api/repos|sessions|events` read no managed tables.
`app.onError` logs `err.message` only; `ChallengePortError` messages carry the code only.

## Disclosed missing checks / limits

- No sign-in rate limit or lockout (credential is ≥ 32 visible ASCII, generated per run).
- Duplicate session cookies fail closed → a page on another loopback port can toss a cookie with a
  narrower Path and cause a sign-in DoS (never a session). No `__Host-` prefix (needs `Path=/`).
- `Secure` omitted over plain-http loopback (R-N7); Chrome storage of the cookie is 09's to verify (N-7).
- Session map lookup is keyed by sha256(cookie) (not a constant-time lookup; no secret-dependent compare).
- Port scope check (`workspace:decide` inside `issue/verify`) is defense in depth and not independently
  exercised: no read-scoped mutation route exists except sign-out; the middleware scope tests cover it.
- ChallengePort is tested against an in-memory `WorkspaceTx` fake (role 02's store not yet present);
  an integration run against the real SQLite store + 04's decision tx is still needed (lead/08).
- The kind-binding failure test flips `kind` on a non-schema row (a schema-valid result row needs a full
  ResultEnvelope); result-gate binding is otherwise covered only through the hash.
- Tests use `app.request` (no socket); real `Bun.serve` + browser cookie handling are 08/09's.
- No Host check beyond the lead's `hostGuard` (any loopback name).
- The exact typed `Edward` confirmation is role 04's, not checked here.
