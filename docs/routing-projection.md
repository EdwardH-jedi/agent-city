# Workspace routing recommendation projection

Status: **prepared** — the display contract exists (`apps/hub/src/routing-projection/projection.ts`, tested); no
route, no UI and no change-facts source yet. Those need the owner decisions below.

The projection shows, next to a workspace draft, which worker profile the model factory *would* recommend for
implementing it — advisory and display-only. It never assigns, runs, queues, proposes or approves anything, and it is
not part of any proposal, Gate 1 / Gate 2 binding or hash. Putting a profile *into* a proposal changes the hashed
proposal snapshot and needs a new proposal contract version (`docs/model-factory.md`), never this projection.

## Contract (built)

`projectRoutingRecommendation(dryRun: unknown): RoutingRecommendation` maps one `dryRunTaskRoute` result
(`apps/hub/src/model-factory/dry-run-route.ts`) to:

| Field | Meaning |
| --- | --- |
| `status` | `RECOMMENDED` · `HUMAN_REQUIRED` (HUMAN route or fail-closed decision) · `NO_PROFILE` (no enabled profile meets the tier, or a configured one fails) · `UNAVAILABLE` (input unreadable / inconsistent) |
| `profile_id`, `profile_source` | the recommended profile and whether it was `assigned` (configured, resolved exactly) or `selected` (first eligible); for `NO_PROFILE` the configured id that failed, if any |
| `tier` | the tier a profile must meet (`required_tier`: enforced route raised to any trusted minimum); null when no lookup happened |
| `policy_reasons`, `policy_override` | every policy rule that held (closed `POLICY_RULES` enum, evaluation order) and whether policy changed the provider's choice |
| `status_reason` | fixed token for non-recommendations (`route_human`, `decision_fail_closed`, `no_matching_profile`, `unknown_profile`, …, `invalid_route`) |
| `projection_version`, `authority: "ADVISORY"`, `display_only: true` | constant markers |

Properties (tests in `projection.test.ts`, 12): real dry runs over the deterministic fake providers for every status;
policy floors raise the tier and are shown as reasons; HUMAN routes never get a profile or a tier; a provider failure
fails closed; malformed / inconsistent / hostile input (throwing getter, Proxy trap) → `UNAVAILABLE`, never a throw;
extra input keys are never copied; output deep-frozen with a fixed key set; source boundary (pure imports, no I/O, no
timers) and nothing in hub / web / schema imports it yet.

## Open decisions (owner)

1. **Change-facts source.** `dryRunTaskRoute` needs `ChangeFacts` from *trusted hub analysis — never the task text or a
   provider*. A draft's only structured, non-text input is `scope.allowed` / `scope.protected` (pattern-restricted
   paths). Proposed: a conservative path classifier — a fact is true when any allowed pattern *may* match a sensitive
   area (auth, authorization / approval contracts, security / redaction / secrets, migrations, deploy / CI /
   credentials); broad patterns (`**`, `apps/**`) set every sensitive fact; `mutates_source` always true;
   `requests_remote_delivery` false (M1 is simulated, no push). Under-classification lowers the shown tier, so it
   must err high. Alternative: show `UNAVAILABLE` until a real analysis exists.
2. **Task size (`scope` TRIVIAL…LARGE).** No trusted analysis exists. Proposed: from structure only (number of
   allowed patterns and criteria, broad patterns ⇒ LARGE); never from text.
3. **Provider.** Only `fake:*` providers exist. Proposed: the deterministic `rulesProvider` behind an explicit
   `ADVISORY_RULES` label in the view, or no provider (fabric fail-closed ⇒ `HUMAN_REQUIRED`) until a real one is
   reviewed. Either way `live.enabled` stays irrelevant: no model is called.
4. **Profiles.** `workerProfileRegistryFromConfig(managed config)`; with no enabled implementer profiles every
   projection is `NO_PROFILE` — acceptable, or hide the panel?

## Next (after the decisions)

- `GET <workspace base>/drafts/:id/routing-recommendation` behind the workspace guard (`workspace:read`), computed on
  read, `cache-control: no-store`, never stored, never part of `request_hash`, proposal snapshot or binding hash;
  adversarial test that drafts / proposals / Gate requests and their hashes are byte-identical with and without it.
- Web: a read-only panel on the draft view (status, profile id, tier, policy reasons), clearly labelled advisory;
  no button that assigns or runs.
