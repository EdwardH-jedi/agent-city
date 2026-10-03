# Evidence (role 06): notes for the lead

Part A covers complete-context diff disclosure. Part B covers sealing the evidence, Gate-2 revalidation, and the
display reader. This directory only; nothing lead-owned was edited.

## Files

| File | Role |
| --- | --- |
| `diff-parse.ts`, `secret-lines.ts`, `disclosure.ts`, `context-loader.ts` | Part A: complete-context disclosure (pure core plus git-object loader). `disclosure.ts` adds `disclosureEvidence()` (maps a result to `EvidenceStatus` verified/withheld plus reason codes) and `renderWithPlaceholders()` (R-E3). |
| `git-runner.ts` | `hardenedGitRunner()`: same hardening as `git.ts` `gitRaw`. It is meant to be replaced by the proposed `gitRunner` export. |
| `run-evidence.ts` | One verified read of an attempt's evidence unit, with a status per item. Shared by the sealer and the reader. |
| `sealer.ts` | `createEvidenceSealer(deps)` implements `EvidenceSealer` (`seal`, `revalidate`). Also `gate2Check` and `revalidateForGate2`. |
| `retained.ts` | `RetainedEvidenceStore`: verified buffers kept under the envelope hash they produced. |
| `reader.ts` | `readArtifactText(deps, input) → ArtifactTextResponse` (v1.1); throws `ArtifactNotFound`. |
| `*.test.ts`, `git-fixture.ts`, `seal-fixture.ts` | Tests and test-only helpers. They use a real Orchestrator with fake adapters on a disposable fixture repo. |

## API

```ts
createEvidenceSealer(deps: {
  db; config: ManagedConfig;
  reads?: { getProposal; getDecision; getApprovalRequest };   // 02 WorkspaceReads; revalidate() needs it
  gitFor?: (cwd) => GitRunner; limits?: Partial<EvidenceLimits>;
  retained?: RetainedEvidenceStore; recheckDisclosure?: boolean /* true */; now?;
}): EvidenceSealer & { retained }
seal(SealInput): Promise<SealedResult>          // rejects with SealError(code) when no envelope can be built
revalidate(ApprovalRequestRow): Promise<SealedResult>
gate2Check(request, resealed) → {ok:true} | {ok:false, code:'integrity_failed'|'evidence_unavailable'}
revalidateForGate2(sealer, request) → {ok:true, sealed} | {ok:false, code, seal_error}
readArtifactText(deps, {managed_task_id, artifact_id, bound?: {envelope, envelope_hash}}): Promise<ArtifactTextResponse>
```

`SealError` codes:
- **Input:** `input_mismatch`, `not_a_result_request`, `revalidation_unavailable`.
- **Engine rows:** `task_not_found`, `run_not_found`, `run_not_result`, `binding_mismatch`, `candidate_missing`, `attempt_out_of_range`.
- **Repo and git:** `repo_unavailable`, `candidate_unavailable`.
- **Candidate workspace (R-A9):** `candidate_workspace_invalid`, `candidate_mutated`.
- **Artifact rows:** `too_many_artifacts`, `artifact_row_invalid`.
- **Review rows (zero reviews = L-06):** `review_missing`, `review_unreadable`.
- **Other:** `envelope_invalid`, `timeout`.

## seal(): sources and checks

1. **Inputs.** `proposal_hash = H(proposal)` and `execution_binding_hash = H(binding)`. The binding must name this proposal, managed task and base, and `proposal.workspace_task_id` must match.
2. **Managed task.** Same repo and base, `simulated`, and `result_run_id = run_id`.
3. **Attempt.** Same task and base; candidate, manifest_hash and parent present; `attempt_no ∈ {1,2}` and `≤ 1 + max_repairs`; attempt 1 has `parent = base`.
4. **Git** (trusted config repo path, immutable objects). The candidate is a commit, and its tree becomes `candidate_tree`. The attempt worktree must resolve inside `workspace_root`, with `HEAD = candidate` and an empty `status --porcelain --untracked-files=all` (R-A9).
5. **Artifacts.** Each row is read at most once with `readArtifactBytes`: containment, `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, fstat of the descriptor, regular file, size = byte_len, full read, sha256 of the same buffer.
   - Bounds: 64 rows, 16 MiB per file, 64 MiB total, 60 s overall deadline.
   - Statuses (worst wins):

| Condition | Status |
| --- | --- |
| Name outside the engine's fixed set, kind ≠ the kind expected for the name, unsafe name, duplicate name | corrupt |
| Row `candidate_sha` ≠ attempt candidate | stale |
| Row over the per-file limit or the byte budget (never read) | unknown |
| Verified read fails (symlink, FIFO/dir/special, missing file, size, sha256, outside root) | corrupt |
| Row truncated | truncated |
| Manifest: sha256 ≠ `run.manifest_hash`, or not a valid EvidenceManifest, or >10 checks | corrupt |
| Manifest names another task/run/attempt/base/parent/candidate/tree | stale |
| Diff or verify log: sha256 or truncated flag ≠ the manifest's entry | corrupt |
| Diff or verify log while the manifest is untrusted | unknown |
| `verify-N-*.log` not named by the manifest | corrupt |
| `changed-files.json` ≠ `manifest.changed_files` | corrupt |
| `review-output.json` does not name this candidate + manifest | stale |
| `review-output.json` unparseable, or verdict/candidate/manifest ≠ the review row | corrupt |
| More than one review row | review output corrupt |
| Diff recheck (fresh `git diff base candidate` → Part A disclosure): withheld or truncated | withheld |
| Diff recheck: stored = raw or legacy `redactDiff` form of this candidate's diff, but ≠ disclosed text | withheld (`diff_not_disclosure_form`) |
| Diff recheck: stored bytes are anything else | corrupt (`diff_not_from_candidate`) |
| Row `meta.disclosure.status` ≠ `disclosed` (can only make the status worse) | withheld |

   Expected required names with no row are added as `missing` items: the manifest, the diff, the review output, and each verify log the manifest names.
6. **Review.** Zero rows means no envelope. The last row (by created_at, id) is hashed as a `ReviewRecord`. Verification results come from the trusted manifest only; otherwise the list is empty, which makes required checks missing.
7. **Envelope.** `sealResultEnvelope` (strict schema, canonical encoding) and `resultEligibility`. The verified buffers of verified/truncated items are retained.

`revalidate(request)` does not take its inputs from the envelope it is checking:
- **Proposal:** from `getProposal`, with a hash check.
- **Gate-1 decision:** the run decision must have `kind=run` and `action=approve` for this managed task, and its run request must be `approved` with the same proposal and execution-binding hashes.

It then re-seals from fresh reads. The caller accepts only `hashesEqual(resealed, request.result_envelope_hash) && eligible`.

## Retained bytes and validation/use immutability

**What is checked against what:** the envelope hash covers every item's identity (`artifact_id`, `sha256`, `byte_len`, `truncated`) and its status, as computed from the buffer that was actually read.
- At Gate 2, a fresh re-seal compares one hash. That one comparison catches byte, row, review, status, candidate, manifest and attempt drift. Tests cover a replaced file, a coherent file+row+manifest rewrite, swapped rows, and changed review rows.

**What is retained:** copies of the verified/truncated buffers of each seal or revalidation, in `RetainedEvidenceStore`, keyed by envelope hash and scoped to task and run.
- It holds at most 16 envelopes and 64 MiB, each for at most 12 h. It lives in memory only, so it is lost on restart.
- Every `take()` re-hashes the retained copy and hands out a new copy.

**How display uses it:**
- If the request's bound envelope hashes to its bound hash and its buffer is still retained, the reader serves that buffer and opens no file.
- Otherwise it does a fresh verified read of the whole unit and serves the buffer from that same read. Any difference from the bound envelope item makes the item `corrupt` with no text. A path is never reopened after it was checked.

**Residual window.** Between revalidate's read and the decision transaction (milliseconds), the accepted hash names the bytes that were read.
- A file replaced afterwards is not what was accepted. It is detected and refused on any later read, but nothing re-checks the file system after acceptance (OQ-10, deferred).
- Retention is memory-only and bounded. After eviction or restart, display falls back to fresh verified reads, which are refused on any difference.

**Not claimed:** protection against a privileged attacker who controls hub process memory, the SQLite file plus the artifact store plus the decisions coherently, or the repository's git object store.

## Residual limitations

- The diff recheck runs git plus Part A CPU inside `revalidate` (in the Gate-2 HTTP handler) and on reader cache misses. That is fine at fixture size (R-E4), and `recheckDisclosure: false` turns it off.
- **Until the orchestrator patch lands,** any diff that needed masking is stored in the legacy `redactDiff` form. That seals `withheld`, so the result is ineligible. This fails closed by design.
- A SealError caused by a transient problem (`timeout`, `repo_unavailable`, `candidate_unavailable`) would currently invalidate a pending Gate-2 request via `integrity_failed`. Suggestion: 04 could map these three to `409 evidence_unavailable` without invalidating.
- The worktree check honours `.gitignore`, as the engine's `mutationSince` does: an ignored file is not detected.
- Review output is stored as `redactLog(JSON.stringify(raw).slice(0, max_log_bytes))`. A sliced large output does not parse, so it is corrupt and the result ineligible.
- The fixed artifact-name set is mirrored from `orchestrator.ts`. A new engine artifact name must be added in `run-evidence.ts` `FIXED_KINDS`.
- `ArtifactAccessError` reasons are mapped by a regex on its message; see proposal 5.
- The deadline is checked between steps. A single synchronous read is bounded by size, not time. Each git call is bounded by its runner (30 s).
- R-E3 partial display conflicts with v1.1 `ArtifactTextResponse`, where `text` is null for `withheld`. The reader follows the contract. Partial text would need an additive field, for example `partial_text`, from 01 as a contract delta.

## Lead-owned patch proposals

**1. `apps/hub/src/managed/orchestrator.ts` evidence step (~918–926)**

Replace `const diffStored = redactDiff(diff.text, { truncated: diff.truncated });` with:

```ts
const refs = listDiffFiles(diff.text, { truncated: diff.truncated });
const contexts = await loadDiffContexts(gitRunner(this.git, worktree), refs,
  { old_rev: t.base_sha, new_rev: candidate },
  { max_file_bytes: config.limits.max_context_file_bytes, max_total_bytes: config.limits.max_context_total_bytes });
const disclosure = decideDiffDisclosure({ diff: diff.text, truncated: diff.truncated, contexts,
  limits: { max_diff_bytes: config.limits.max_diff_bytes, max_file_bytes: config.limits.max_context_file_bytes,
            max_total_context_bytes: config.limits.max_context_total_bytes } });
const shown = disclosureEvidence(disclosure);
const diffStored = disclosure.status === "disclosed" ? disclosure.text : renderWithPlaceholders(disclosure);
```

- The diff artifact gets `meta: { disclosure: { status: shown.status === "verified" ? "disclosed" : "withheld", reasons: shown.withheld_reasons } }`.
- Next to the existing `if (after) return this.fail(…, store)`, add:

  ```ts
  if (shown.status === "withheld")
    return this.fail(t, claim, run.id, "evidence_invalid",
      `the diff cannot be safely disclosed (${shown.withheld_reasons.join(",")}); nothing was sent to the reviewer`, store);
  ```

  This follows R-E1/L-13: truncated diffs fail here too, and the reviewer only ever gets disclosed text.

**2. `apps/hub/src/managed/git.ts`**

```ts
export function gitRunner(ctx: GitCtx, cwd: string) {
	return (args: readonly string[], maxOutputBytes: number) => gitRaw(ctx, cwd, args, maxOutputBytes);
}
```

Pass `gitFor: (cwd) => gitRunner(gitCtx, cwd)` to the sealer and the reader.

**3. `apps/hub/src/managed/config.ts` `Limits`**

```ts
max_context_file_bytes: z.number().int().min(1024).max(16_777_216).default(1_048_576),
max_context_total_bytes: z.number().int().min(1024).max(67_108_864).default(16_777_216),
max_evidence_bytes: z.number().int().min(1024).max(268_435_456).default(67_108_864),
```

Feed `max_evidence_bytes` to the sealer as `limits.max_total_bytes`.

**4. `apps/hub/src/managed/evidence.ts` `writeArtifact` (L-14, atomic)**

- Before writing, check that the realpath of the parent directory is inside the realpath of the root.
- Write the file:

  ```ts
  const tmp = `${abs}.tmp-${randomUUID()}`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, abs);                           // replaces a planted symlink itself, never its target
  const dfd = openSync(dirname(abs), constants.O_RDONLY); try { fsyncSync(dfd); } finally { closeSync(dfd); }
  ```

- Only then call `insertArtifact`.
- Today's `writeFileSync(abs)` follows a symlink planted at `abs`. A crash can also leave a partial file behind a row.

**5. `evidence.ts` `ArtifactAccessError`**

Add a machine field `reason: "symlink" | "special_file" | "missing" | "size" | "hash" | "outside" | "oversized" | "short_read" | "unreadable"`. That would replace the regex mapping in `run-evidence.ts`.

**6. Hub wiring (`index.ts` / `routes/workspace.ts`)**

- Create one `RetainedEvidenceStore` per hub process. Build one sealer with `createEvidenceSealer({ db, config: frozenConfig, reads: workspaceStore, retained, gitFor })` and give the reader the same `retained`.
- **Bridge (05), at human_ready, outside any transaction:**
  - `SealError` → `result_unavailable`.
  - Ineligible → insert the request as `invalidated(evidence_unavailable)` (OQ-7).
  - Eligible → pending, with `result_envelope = sealed.canonical` verbatim.
- **Decisions (04):** call `revalidateForGate2(sealer, request)` before `BEGIN IMMEDIATE`.
- **Artifact route:** map the workspace task to its managed task(s), then call `readArtifactText(…, { managed_task_id, artifact_id, bound: currentResultRequest ? { envelope, envelope_hash } : null })`. `ArtifactNotFound` → 404.

**7. Contract (01), optional additive delta**

`ArtifactTextResponse.partial_text` for R-E3.

## v1.2 corrective (Fix 2 durable accepted evidence + Fix 3 current acceptance validity, backend)

Binding spec: `docs/workspace-m1/CONTRACT_V1_2.md` §B/§C. Supersedes "Residual window" / OQ-10 above.

### Files (new / changed)

| File | Role |
| --- | --- |
| `bundle.ts` (new) | `agentcity.evidence-bundle/v1`: `attachSealedEvidence`/`sealedEvidenceOf` (WeakMap: the sealer's verified buffers behind exactly its `SealedResult` object), `buildBundle`, `publishBundle`, `publishSealedEvidence` (build + publish → `EvidenceBundleRow`), `verifyBundle`, `LEGACY_RESULT_DETAIL`, `DURABLE_SEAL_FAILED_DETAIL`. |
| `validity.ts` (new) | `checkAcceptedEvidence` (sync: bundle + every bundled source artifact), `checkAcceptedCandidate` (git), `checkAcceptance` (both), `subjectOf`, `patchFor`, `recordAcceptanceVerdict` (one tx; sticky rows untouched). |
| `sealer.ts` | `seal()` attaches its verified/truncated buffers to the returned object (no other change; `revalidate` never publishes). |
| `reader.ts` | `readArtifactFromBundle` (bundle-only serving); `respondWith` extracted; `use_retained: false` input. |
| `bundle.test.ts`, `validity.test.ts` (new) | 17 tests. |

Lead-lease files changed (decisions/): `decision-service.ts` (Gate-2 accept only), `read-model.ts`, `test-support.ts` (`openGate2` publishes like the bridge; `bundlePath`). New test `decisions/durable-acceptance.test.ts` (11).

### What is stored where, who writes, how verified

- **Bundle file** `<artifacts_root>/_sealed/<digest>.bundle` (dir 0700, file 0600): header line = canonical JSON `{contract, result_envelope_hash, managed_task_id, run_id, items:[{name, artifact_id, sha256, byte_len, offset}]}` + `\n` + item bytes in header order. Items = the envelope's `verified`/`truncated` artifacts, in envelope order, from the buffers `readArtifactBytes` returned during THAT seal (re-hashed against each item before writing). `digest = sha256(file)`.
- **Writer**: only the bridge reconciler at Gate-2 opening (and `openGate2` in tests), BEFORE the result request row; the bundle row + the request naming it commit in one transaction. A copy of a `SealedResult` (spread) has no buffers → `no_sealed_buffers` → publication failure (fail closed).
- **Publication**: `_sealed` created 0700 (an existing symlink / non-directory is refused), temp `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` 0600, full write, fsync, rename to the content address, fsync dir. Existing target: must be byte-equal (safe read) or `target_conflict`; never overwritten.
- **verifyBundle** (never throws): realpath root; `_sealed` lstat must be a real directory; open `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`; fstat regular; size ≤ cap (64 MiB + 64 KiB header) and = recorded byte_len; one bounded read; deadline (10 s); sha256 = digest; header ≤ 64 KiB, strict zod, re-encoded canonical text identical; offsets tile the body exactly; binding = request's `result_envelope_hash`, envelope task/run, and EXACTLY the envelope's verified/truncated items (id, name, sha256, byte_len, order); every slice hashes to its item. Codes: `bundle_missing | bundle_not_regular | bundle_oversized | bundle_hash_mismatch | bundle_header_invalid | bundle_binding_mismatch | bundle_unreadable`.
- **Transient classification (clarification of §B)**: `bundle_unreadable` from `EMFILE/ENFILE/EIO/EINTR/EAGAIN` or the deadline is `transient` → Gate 2 answers 409 `evidence_unavailable` with no write; validity → `unknown`. `EACCES/EPERM` and every other code are non-transient → Gate 2 409 `integrity_failed` + request invalidated ("Gate-2 revalidation failed (durable evidence bundle: <code>)"); validity → `invalid`.

### Gate 2 accept (decision-service.ts; Gate 1 and the Fix-1 `authoritativeNow()` clock untouched)

Outside any tx: legacy request (no digest) → invalidate (`evidence_unavailable`, LEGACY wording) → 409 `evidence_unavailable`; existing re-seal (unchanged); then `verifyBundle` (never republish) — failure handling above. Inside the tx, before the challenge is consumed: request digest non-null (`evidence_unavailable`) and constant-time equal to the verified digest (`integrity_failed`). After the point of no return: decision row + receipt `effects.evidence_bundle_digest` = digest; validity row `valid` (`checked_at = decided_at`) inserted right after the decision (before `after_insert_decision`); the final effects assertion also checks the validity row. Replay unchanged (stored receipt). Reject/request-changes: no bundle check, no digest.

### Serving (read-model.ts → reader.ts)

Result request with a digest and status ≠ invalidated (pending / accepted / rejected / changes_requested) → `readArtifactFromBundle` only: name/kind/truncated/status from the sealed envelope item, bytes = slice of the single verified read; the mutable store is never read. Non-retained envelope status (e.g. withheld) → that status, `text:null`. Bundle failure → `corrupt` (`unknown` if transient), `text:null`, reason = code. Invalidated requests (R-F5 / ADV-EVID-19 kept): not served from the bundle; fresh disk read with the retained copy disabled and the sealed item still required (`differs_from_sealed` → corrupt). The retained in-memory store is a cache only for legacy bound requests; it is never consulted for bundled requests.

### Current validity (validity.ts + read-model.ts + bridge sweep)

- Evidence: bundle (above) → `bundle_missing | bundle_corrupt | bundle_binding_mismatch`; every bundled item: its `managed_artifacts` row (missing → `source_evidence_missing`; run/name/sha256/byte_len ≠ bundle item → `source_evidence_changed`) and its file read with `readArtifactBytes` against the BUNDLE identity (missing file → `source_evidence_missing`; anything else → `source_evidence_changed`).
- Candidate: managed task's repo from the trusted config; `rev-parse --verify --quiet <c>^{commit}` exit 1 → `candidate_unavailable`; `^{tree}` ≠ envelope `candidate_tree` → `candidate_mismatch` (also catches `git replace`). Repo not configured / path gone / git not spawned / timed out / exit ≠ 0,1 → `unknown` (`verification_unavailable`).
- First invalid wins (evidence before candidate), then unknown, else valid. `recordAcceptanceVerdict` writes in one tx; `invalid`/`unverifiable` rows are never touched (store + trigger).
- Internal `taskDetail` can start a full background check when the stored check is older than 5 s (or stamped in the future), with in-flight throttling; its evidence-only check runs inline. The public detail router uses `taskDetailChecked` and awaits the full check, including candidate Git verification. `taskView` (mutations) and snapshot/list items show the stored row without checking. Accepted task without a row (written around the service) → synthesized `unknown`, never `valid`.

### Guarantees and limits (exact)

- After Gate-2 opening, the accepted bytes exist durably and content-addressed outside model worktrees; restart / retained-cache eviction serve them byte-identically from the verified bundle (tests: barrier swap, restart, `retained.clear()`).
- A source swap between validation and commit (review barrier) still commits (the accepted hash names the verified bytes, as before) but can never substitute content, and the next due read/sweep marks the acceptance `invalid` (sticky) while history (decision, receipt, task `accepted`) is unchanged.
- **Residual windows**: (1) a detail read within 5 s of the last check shows the stored verdict (the extended probe's `validity_first_read: "valid"` is a read < 5 s after accept). Snapshot/list reads never check; the periodic sweep runs every 30 s through a serial queue, checking at most 20 eligible results oldest first, so N results need about ceil(N/20) sweeps plus queue/check time. There is no universal next-sweep or 5/30-second detection bound (CONTRACT_V1_2.md §C). (2) background findings become visible on a later read; (3) a source open failure caused by fd exhaustion reads as `source_evidence_changed` (sticky) — `readArtifactBytes` does not expose errno; (4) bundle publication is not fsync-proof against a lying disk.
- **Not claimed**: protection against a privileged attacker who can rewrite the artifacts root AND the SQLite file coherently (e.g. a new bundle plus rewritten digest/envelope columns — the 009 triggers stop ordinary writers, not a rewrite of the DB file), hub process memory, or the repository object store beyond the `^{commit}`/`^{tree}` check.

## v1.2 Fix 4 — criterion coverage (CONTRACT_V1_2.md §A), backend integration

- `sealer.ts`: `SealInput.proposal` is `AnyProposalSnapshot` (sealed with `sealAnyProposal`, which also refuses a v1.2 id ≠ id(text)). A v1.2 proposal seals `agentcity.result/v1.2` with `criterion_coverage = deriveCriterionCoverage(proposal.coverage_plan, envelope)` (pure; never inferred), sealed with `sealAnyResultEnvelope`. Eligibility is ALWAYS `resultEligibilityV1_2(envelope, proposal)`: a legacy v1 proposal seals a v1 envelope that is ineligible (`criteria_unmapped`). The bundle is unchanged (it depends only on artifacts / ids).
- `reader.ts`, `validity.ts`, `bundle.ts`: envelope types widened to the v1 | v1.2 union (`sealAnyResultEnvelope` for the bound-envelope check).
- `bundle.ts`: `LEGACY_PROPOSAL_DETAIL` ("…legacy proposal without criterion coverage (criteria_unmapped); a new proposal and approval are required").
- `seal-fixture.ts`: `humanReadyRun()` builds a v1.2 proposal (criterion → `fixture-check`, explicit); `{ legacy: true }` = v1.
- Tests `coverage.test.ts` (4): clean coverage = derivation, satisfied with the log identity, inside the hash, revalidation reproduces it; a failed mapped check (manifest rewritten coherently, reviews re-bound) → `unsatisfied` → ineligible (`criterion_unsatisfied`); passed check whose log row is gone → `unresolved` (`criterion_unresolved`); legacy v1 → v1 envelope, `criteria_unmapped`, gate2Check `evidence_unavailable`. (The real engine never reaches human_ready on `verification_fails`, so "failed → unsatisfied" is proven at the sealer.)
- Decisions (lease): publish = `buildProposalSnapshotV1_2` over the stored draft + trusted `required_checks`, `contract_version` v1.2, 400 `invalid_request` + issues on unmapped / dangling / untrusted / empty / duplicate (incl. two texts freezing to one id); rerun of a legacy v1 proposal → 400 (it could never be accepted); Gate-2 accept additionally recomputes `resultEligibilityV1_2(stored envelope, stored proposal)` before the re-seal — ineligible (e.g. legacy `criteria_unmapped`) → request invalidated(`evidence_unavailable`, explicit detail) → 409. Tests `decisions/criterion-coverage.test.ts` (12).
