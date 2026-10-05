# Decision Fabric (core, v0)

`apps/hub/src/decision-fabric/` — an internal decision layer that a decision model (later: Jev) can
plug into. **A model recommends; it never decides and never grants execution authority.** The Hub's
own gates and human approval stay authoritative.

```
DecisionProvider ──► Recommendation ──► deterministic policy ──► advisory decision
 (provider.ts)        (strict zod,        (policy.ts: pure,       (fabric.ts: both kept,
                       bound to input)     overrides allowed)      deeply frozen)
```

Nothing is wired in yet: no route, no queue or workflow mutation, no network, no model, no process.
Remote delivery (push / PR / merge) is not a decision kind at all.

## Files

| file | role |
|---|---|
| `vocabulary.ts` | **the only routing vocabulary**: route tokens `FAST < STANDARD < SENIOR < PRINCIPAL` (compile-checked against the canonical `WORKER_LINEAR_CAPABILITY_TIERS`, ranked by `WORKER_CAPABILITY_RANK`), the separate `HUMAN` route outcome, `isCapabilityRoute`, `routeTarget` (→ canonical lowercase tier) |
| `contracts.ts` | decision kinds, structured inputs (`ChangeFacts` flags, all required), closed choice sets, strict `Recommendation` |
| `hash.ts` | canonical key-sorted JSON + sha256 (`node:crypto`) |
| `policy.ts` | deterministic enforcement, every threshold exported |
| `provider.ts` | `DecisionProvider` interface |
| `fabric.ts` | `decide(provider, request)` → `DecisionResult` / `UnsupportedResult` |
| `fake-provider.ts` | deterministic in-process providers (fixed, rules, raw, throwing, hanging) |

## Kinds and choices

| kind | choices | fail-closed |
|---|---|---|
| `TASK_ROUTE` | FAST, STANDARD, SENIOR, PRINCIPAL, HUMAN | HUMAN |
| `ESCALATION` | RETRY_SAME_TIER, ESCALATE_TIER, HUMAN | HUMAN |
| `REVIEW_DEPTH` | NO_SEMANTIC_REVIEW, STANDARD_REVIEW, DEEP_REVIEW, SECOND_REVIEW, HUMAN_REQUIRED | HUMAN_REQUIRED |
| `POST_REVIEW` | READY_FOR_HUMAN, SAME_TIER_REPAIR, ESCALATE_REPAIR, SECOND_REVIEW, HUMAN_REQUIRED, STOP | HUMAN_REQUIRED |
| `QUEUE_PRIORITY` | RAISE, KEEP, LOWER | KEEP (no change) |
| `HUMAN_ESCALATE` | ESCALATE_TO_HUMAN, CONTINUE_AUTONOMOUS | ESCALATE_TO_HUMAN |
| `OVERNIGHT_CONTINUE` | CONTINUE, PAUSE_FOR_HUMAN, STOP | PAUSE_FOR_HUMAN |

`TASK_ROUTE`, `ESCALATION` and `POST_REVIEW` also carry a `route` (`RouteOutcome`). `HUMAN` means
"no worker-profile lookup — a person decides"; the four tiers map to Worker Profile Registry tiers.

## Recommendation (what a provider returns)

`decision_kind`, `choice` (`[A-Z0-9_]{1,64}`), `confidence` (finite, 0..1), `provider` (must equal
the provider's `id`), `input_hash` (must equal the request's), `reason_codes` (≤ 8 unique
`[A-Z0-9_]{1,64}`), optional `metadata` with fixed keys only (`provider_version`, `trace_id`,
`latency_ms`, `cache_hit`). Strict: any other key (`reasoning`, `chain_of_thought`, `findings`, …)
rejects the whole answer. Reasoning is never requested, stored or exposed; rejections keep a code,
never the provider's text.

`input_hash` = sha256 of canonical JSON `{version, decision_kind, input}` over the zod-normalized
input (key order irrelevant, array order significant).

## Policy (deterministic; `policy.ts`)

| rule | effect |
|---|---|
| `requests_remote_delivery` / `touches_deploy_or_credentials` | human outcome for every kind (HUMAN / HUMAN_REQUIRED / ESCALATE_TO_HUMAN / PAUSE_FOR_HUMAN) |
| no usable recommendation (invalid input, provider error/timeout, malformed, mismatched, unsupported choice) | kind's fail-closed choice |
| confidence `< MIN_CONFIDENCE` (0.7) | conservative: route ≥ SENIOR, review ≥ DEEP_REVIEW, post-review → HUMAN_REQUIRED, retry → escalate, priority → KEEP, continue → pause/escalate |
| route floors | auth → ≥ STANDARD, authorization/approval contracts → ≥ STANDARD, security → ≥ SENIOR, DB migration → ≥ SENIOR |
| review floors | any source mutation or non-support artifact → ≥ STANDARD_REVIEW; auth/security/migration → ≥ DEEP_REVIEW; authorization → ≥ SECOND_REVIEW. NO_SEMANTIC_REVIEW only for read-only support artifacts with no flags |
| post-review | REVIEWER REJECT never yields READY_FOR_HUMAN (applied last); blocker finding → not ready; repairs need an actionable finding; ≤ 2 same-tier repairs, ≤ 4 total; no tier above PRINCIPAL → HUMAN_REQUIRED; findings are carried through unchanged |
| escalation / autonomy | ≤ 2 attempts per tier; 3 consecutive failures → human; budget exhausted → STOP; a task waiting ≥ 1 h is not lowered |

The route floors follow the spec literally (auth/authorization: "never FAST"). They live in one
exported table (`ROUTE_FLOORS`) to tune.

## Result

`decide()` never throws. A `DecisionResult` holds `recommendation` (validated provider output, or
null) and `decision` (enforced: `choice`, `route`, `fail_closed`, `reason_codes`, `policy_override`
with every `{rule, from, to}` step, `findings`) side by side, plus `input_hash`, `provider_id`,
`recommendation_status`, `rejection_code` and `authority: "ADVISORY"`. An unknown kind gives
`UnsupportedResult` (`fail_closed`, `human_required`).

## Integration notes

- `vocabulary.ts` derives from the canonical Worker Profile tiers (`@agent-city/schema`); it is the only
  file here that imports the schema, and nothing else names tiers. `routeTarget` hands the Worker
  Profile Registry a canonical tier; `specialist` is never a route. The dry-run composition with the
  registry and the support lane is `apps/hub/src/model-factory/`.
- `ReviewFinding` mirrors the managed `Finding` shape so reviewer findings pass straight through.
- The `ChangeFacts` flags must come from trusted Hub analysis, never from the provider.
