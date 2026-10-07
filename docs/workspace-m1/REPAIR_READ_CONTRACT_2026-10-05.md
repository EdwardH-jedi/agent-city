# Additive read contract: review residuals, 2026-10-05

Written before implementing the read changes. Baseline: d158571a8103d2bee315399ddea09607ccea1702. Findings APP-P2-01 and APP-P2-02. The candidate remains CLOSED_PENDING_REVIEW. Approval payloads, bindings, challenges, decisions, evidence and execution authority are unchanged.

## Whole repository facts

`repo_summaries` adds one complete aggregate per allowlisted repository. Each workspace task is counted once, from its stored stage, CURRENT linked managed execution state, and stored accepted-decision validity. Grouped SQL counts are classified using the canonical phase derivation; no full task history or artifact bundles are loaded. The disjoint categories are running, queued, cancelRequested, needsApproval, needsAcceptance, attention, cancelled, accepted, rejected and drafts. Accepted invalid or unknown validity needs attention; unverifiable historical acceptance is separately disclosed. `phases` counts all canonical phases. `acceptance` counts valid / invalid / unknown / unverifiable facts, and records the oldest/latest stored check timestamps. These are stored check facts, never a promise that every artifact is freshly revalidated. `as_of` is the synchronous read time. `tasks` remains a bounded display window, maximum 500; absence has no authority or zero-count meaning. Old responses without aggregates are explicitly incomplete.

Queue summaries count current workspace tasks in active phases, separately from managed executions in the claimable queue. Every queue entry retains its own repository ownership even when its workspace task is outside the display window. Inbox entries carry server-derived `repo_id` and `task_title` read from their owning task; these are display facts and never approval authority. Complete per-repository pending-request totals remain available outside the 500-item inbox window.

## Bounded reads and mutable collections

GET `/task-history`: required allowlisted `repo_id`, `filter=all|attention` (default all), `limit=1..100` (default 50), optional bounded cursor. Tasks order by immutable `(created_at DESC, id DESC)`. GET `/inbox`: optional allowlisted `repo_id`, `kind=run|result` (default both), `limit=1..500` (default 50), optional bounded cursor. Requests order by immutable `(created_at ASC, id ASC)`. Response metadata names total matching rows, returned page count, complete, has_more, next_cursor and as_of. At most limit plus one row is selected; all parameters are bound SQL values.

Cursors are base64url JSON naming the version, the collection (`history` | `inbox`), the exact repository
scope, the filter (`all` | `attention` for history; `all` | `run` | `result` for the inbox), the page size, and
the last row's immutable key (`created_at` + its unique id). A cursor used with any other collection, scope,
filter or page size, or one that does not parse, is refused with 400; an unallowlisted repository with 422. A
cursor grants nothing: it only selects where a read of the caller's own authorized scope continues. Paging is
keyset paging over an IMMUTABLE order, so no snapshot or revision fingerprint is needed: rows never move, new
rows land at one end (history: newest first, so new tasks appear before page one; inbox: oldest first, so new
requests appear at the end), a decided request simply leaves the pending set, and every id appears at most once
in a scan. Each page is a current read — its rows show their state at that read and its `total` is the current
total; membership of a filtered view (e.g. `attention`) may change between pages, which `total` / `as_of`
disclose. There is no 409 / forced restart: an earlier draft of this contract proposed invalidating cursors on
any revision change in scope, which would have refused "load more" whenever any execution in the repository
progressed or any challenge was issued. The aggregate and the rows of one read share one SQLite read
transaction. The snapshot's own first inbox page uses `SNAPSHOT_INBOX_LIMIT` (500, api.ts), so a client continues
it with that page size.

The client keeps previously loaded rows on page errors and exposes Retry / Refresh; it never loops through every page automatically. Filter, repository, navigation or auth generation changes invalidate in-flight page tickets. Page merges deduplicate by unique id, preserve newer revisions and sticky invalid validity, and never reopen controls closed by a committed receipt. Selecting a paged request uses the existing task detail, challenge and decision workflow. Global and filtered inbox metadata describe the server query; text search describes only the loaded rows.

## Inbox membership generation (T0-FINAL-P2-01, additive, 2026-10-07)

Finding: a fully loaded (exhausted) global inbox kept a closed request and hid a new one when a request beyond
the first page closed and another opened in the same repository and gate — total, first page, cursor and every
per-repository count stayed equal, so no aggregate could tell. Aggregates are not a membership identity.

Contract: every `PendingInboxPage.page` and the snapshot's `pending_page` (both `InboxPageMeta` in api.ts; history
pages keep the strict `PageMeta` and never carry it) gain `membership_generation`, an opaque string computed by
the hub in the same read transaction as the page, over exactly the page's scope (its repositories — the filtered
repository, or the whole allowlist when unfiltered — and its gate):

    v1:<sha256 of [sorted repositories, gate] (16 hex)>:<entered>:<pending>

`pending` is the scope's pending total; `entered` counts the scope's requests that were ever pending —
`status = 'pending' OR rev > 1`. Migration 008 makes that exact and the set monotonic, with no new migration:
requests are never deleted (`managed_approval_requests_no_delete`); a closed request never changes and every
update bumps `rev` by exactly one (`managed_approval_requests_update_rules`), so a request created already closed
(the reconciler's invalidated-at-birth result) stays at rev 1 and is never counted, and one closed after being
pending always is; `kind`, `workspace_task_id` and the task's `repo_id` are immutable. The entered and the closed
sets therefore only grow: equal values from one hub name the identical pending set, and every opening or closing
in the scope changes the value — also at an unchanged total. It never returns to an earlier value. Challenge
issuance and other changes to a still-pending request leave it unchanged. It is compared for equality only,
orders nothing and grants nothing (no route accepts it). Absent (a source that does not compute it, e.g. the
fixture transport, whose snapshot carries no `pending_page`) = unknown. Cost: one grouped count over the scope's
approval requests per inbox read, in the same class as the snapshot's existing full-table aggregates.

Client: the unfiltered continuation records the membership basis of the snapshot it continues —
`[membership_generation, aggregates]` (`membershipBasis`, store.ts). A later server snapshot with another basis
drops the continuation and any page in flight, exactly as for a changed total; Headquarters then shows that
snapshot's first page with its Load more. Nothing is read automatically: a reset reads nothing, unchanged polls
read nothing, each Load more reads one bounded page. A repository- or gate-filtered view stays a single server
read disclosed with its read time, as before.

## Bounds and validation

No caps are raised. No migration was needed: the inbox query is served by the existing `idx_approval_status (status, created_at)`, and a repository history page filters one repository's rows (a bounded local scan; query plans recorded in the external evidence). An earlier draft added `011_workspace_read_pages.sql`; it was dropped before any run so `PRAGMA user_version` stays 10. Query plans and cap/mutation/auth-race probes must be recorded. Frozen approval and evidence vectors must still pass. This document describes intended semantics; measured evidence and implementation status are reported separately in the corrective report and external handover.
