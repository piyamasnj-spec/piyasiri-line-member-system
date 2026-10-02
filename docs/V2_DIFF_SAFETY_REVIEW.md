# V2 diff and safety review

2026-10-02 — **STATUS: REVIEW PASS**, scoped to the emulator-only implementation and proposed commits below. No blocking financial-integrity or security regression was found. This is **not permission or technical readiness to deploy/enable V2 on remote Staging**; that requires the separate transport/configuration gates below.

## Reviewed baseline and scope

Branch `staging`, HEAD `d1a53399dcd88256d0f1237ad52358206212e3d9`. The existing V2 work is untracked, so an empty `git diff` alone is not a review. Inspected all 27 pre-existing untracked files, compared optimization source with workspace `outputs/before-local-contention-20261002/`, and checked the six source hashes in `outputs/v2-local-contention-comparison.json`. They still match the previously tested implementation. Tracked source/configuration has no diff against HEAD, including RTDB v1, existing Netlify entrypoints and the public build script.

Reviewed the three V2 modules, Firestore emulator rules/index configuration, fixture importer, capacity/workload/diagnostic scripts, tests and dated evidence/planning documents. One historical RTDB-only test runner is outside the V2 commit scope and is explicitly held back below. No unrelated application edit was found. Older capacity documents describe historical blocked states or superseded paid proposals; this review and the owner's current $0 restriction do not authorize their execution.

## Safety findings

| Area | Result and evidence |
|---|---|
| Atomicity | `firestore.mjs:134` sends all mutations plus verification preconditions in one atomic Commit. No batchWrite, independent balance/stock updates or process-local lock is used. Financial queries remain prohibited. |
| Complete read set | Every snapshot document read participates once: mutated/deleted paths carry their version, read-but-unwritten paths carry `verify`. Writer control, admin session, identities, receipt absence and missing guards are included. `set`/`delete` require a prior read. |
| Version/ABA | `firestore.mjs:100` fails closed on missing version metadata; raw `updateTime` strings are retained without Date/number precision loss. New actual-emulator ABA and delete/recreate tests force a stale version and observe one conflict, fresh reads and one financial result. |
| Missing documents | `exists:false` prevents concurrent creation from slipping through. Absent -> created -> deleted before commit is an absence-state check, not a historical-event detector; no application receipt garbage collection/deletion was introduced. Idempotency depends on retaining receipts. |
| Idempotency | `member-store.mjs:71,119` reuses existing scoped receipt IDs, payload fingerprints and exact result replay. The receipt is committed atomically with debit, stock, history and summary. Existing same-key/mismatch/response-loss/cancel-complete regressions remain applicable. |
| Batch reads | The optimization batches known paths but does not remove a read/validation or move financial checks outside the snapshot. Missing create IDs and summary shards are still read before mutations. |
| Bounded retry | Default 12 attempts, 20–499 ms jitter, fresh callback state each attempt. ABORTED retries; commit-phase version/existence conflicts retry. Other errors escape. Unknown commit outcomes are not blindly replayed. A new forced-conflict test exhausts a configured two-attempt bound with no financial records or partial debit. |
| Authorization | HTTP factories keep LINE verification and signed/admin session/origin checks. Financial mutations recheck session data and expiry; that session version is verified at commit. Profile whitelist and identity checks remain. No client/sessionStorage authorization boundary was added. |
| Target isolation | `emulatorTarget` permits only explicit emulator mode, demo project, loopback port 8085 and dev/test context, checked at creation and requests. Handler wrappers also check it before authentication. Remote/Staging/Production targets are rejected. Redirects are rejected. Synthetic namespace/import guards remain. |
| Rules/frontend | Local rules deny client reads/writes. `Bearer owner` is only the emulator marker, not a cloud credential. Public build copies index/src/assets only. No V2 routing/import was added to existing application entrypoints or frontend. Proposed indexes were reviewed against current queries; managed index readiness is untested. |

The safety argument relies on documented server semantics: Commit applies its operations atomically; `updateTime` preconditions require the matching current document version; creation/update timestamps advance through changes and delete/recreate. Sources: [Commit](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/commit), [Precondition](https://firebase.google.com/docs/firestore/reference/rest/v1/Precondition), [Document version metadata](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents#Document).

No claim is made that the 55-second post-conflict elapsed check is a hard request deadline. Per-RPC timeout is 12 seconds, and a logical call can exceed 15 seconds under slow/failing transport. Prior local performance acceptance was measured, not a universal timeout guarantee. A Staging adapter must explicitly resolve the runtime/deadline/unknown-outcome policy before enablement; do not simply label a timed-out commit as failed.

## Secret and artifact review

Pattern-scanned all 28 files after adding the review tests, checked syntax of all MJS files and parsed JSON configurations. No private-key, service-account private-key value, Google API-key shape, GitHub/AWS token shape or signed-token-shaped literal was found. Manually inspected the two credential-like assignment locations: both are intentionally synthetic test credentials. Emulator owner markers and checksum/result hashes are not Production credentials. No environment/credential stores or Production data were accessed. The report itself contains no credential values.

The candidate repository files are source, tests, proposed local configuration and Markdown only. Portable Java/JARs, generated archives, memory logs, output reports, temporary files and existing `.env`/dist content are excluded from the commit plan. Pattern scanning is not a guarantee of detecting every possible secret; this conclusion combines scanning with source and target review.

Inventory/hash evidence: workspace `outputs/v2-safety-review-inventory.json`. The final inventory includes this report. Do not commit that workspace output file or runtime binaries.

## Tests and validation

Fresh targeted run: **13/13 PASS, 0 failed, 0 skipped** on the actual local Firestore emulator and Node v24.19.0:

- 10 existing transport/retry checks from `tests/v2-retry.test.mjs`.
- 3 new emulator checks from `tests/v2-safety-review.test.mjs`: writer ABA A->B->A, deletion/recreation of identical session data, persistent real version conflicts through retry exhaustion.

The new tests use an independent peer store for deterministic interleavings, verify balances/stock/history and read receipts by their exact keys. Receipt documents do not contain an `id` field, so querying them ordered by `id` is not a valid completeness check. The initial review-test assertion used that incorrect query; it was corrected to direct receipt lookups before the final passing run. No implementation repair was necessary. Both initial and final logs are retained.

Reused prior **98/98 PASS** plus three successful workload/diagnostic repetitions after verifying source hashes. This is not 111 distinct cases or a new full-suite run: the 10 transport checks overlap the prior 98. No large workload, archive generation, RTDB emulator, live E2E or build/deploy was repeated. Emulator memory guard stayed enabled and the owned emulator was stopped.

Fresh result: `outputs/v2-retest-regressions-safety-review-20261002.txt`; guarded run: `outputs/v2-safety-review-run.json`; runner: `outputs/run-v2-safety-review-local.mjs`. Cost incurred: **$0**.

## Exact proposed commit plan — NOT EXECUTED

Only after separate owner authorization, remain on `staging`. Before staging each group, compare the explicit file set with this inventory, review staged diff and scan it for secrets/artifacts; never stage the entire workspace with `git add .`. No push/deploy is implied by permission to commit. A later branch push can trigger Netlify and therefore needs separate authorization.

### Commit 1: `Add emulator-only bounded Firestore V2 transactions`

Exactly 11 files:

```text
netlify/functions/lib/v2/firestore.mjs
netlify/functions/lib/v2/member-store.mjs
netlify/functions/lib/v2/handlers.mjs
firebase/firestore.emulator.json
firebase/firestore.local.rules
firebase/firestore.local.indexes.json
scripts/v2-synthetic-fixture.mjs
tests/v2-helpers.mjs
tests/v2-integration.test.mjs
tests/v2-retry.test.mjs
tests/v2-safety-review.test.mjs
```

### Commit 2: `Add synthetic V2 capacity and contention diagnostics`

Exactly 8 files. `planned-capacity.mjs` supplies the shared synthetic generator imported by the V2 envelope generator; it does not alter the RTDB v1 implementation.

```text
scripts/planned-capacity.mjs
scripts/v2-capacity-envelope.mjs
scripts/verify-v2-capacity-archives.mjs
scripts/probe-v2-capacity.mjs
scripts/test-v2-workload.mjs
scripts/diagnose-v2-contention.mjs
scripts/audit-v2-free-capacity.mjs
tests/v2-capacity-envelope.test.mjs
```

These diagnostics require the documented local workspace artifacts/outputs directory; some deliberately fail without them. They are not automatic Netlify build hooks or general-purpose cloud importers. Retention/workload scripts must use their documented mode; do not rerun historical generation by default.

### Commit 3: `Document V2 capacity evidence and safety review`

Exactly 9 files:

```text
docs/FIRESTORE_V2_LOCAL_RESULTS.md
docs/PLANNED_CAPACITY_EVIDENCE.md
docs/V2_CAPACITY_RETEST_RESULTS.md
docs/V2_CAPACITY_RETEST_RESUME.md
docs/V2_ISOLATED_CAPACITY_TEST_PLAN.md
docs/V2_CAPACITY_COST_CONFIG_PREFLIGHT.md
docs/V2_ZERO_COST_CAPACITY_REVIEW.md
docs/V2_LOCAL_CONTENTION_RESULTS.md
docs/V2_DIFF_SAFETY_REVIEW.md
```

Total: **28 explicitly listed files**. Leave `scripts/test-planned-capacity.mjs` untracked and untouched: it is the earlier RTDB-only diagnostic, not needed for this V2 commit. Do not delete or run it. This explains the one intentionally excluded file in the 29-file pending inventory.

## Proposed Staging validation plan — NOT AUTHORIZED OR EXECUTED

1. **Readiness gate:** select an owner-approved isolated synthetic-only Firestore target and namespace, distinct from Production and the existing live Staging fixture. Do not assume the existing RTDB staging project already has a usable Firestore database. Confirm $0 eligibility and quotas before any resource or request that could incur cost; otherwise stop. No paid runner or billing upgrade.
2. **Separate adapter review:** implement only after authorization a test-only remote transport with strict project/database/origin/context allowlists, server-only test IAM credentials and proper OAuth. Preserve all read-set preconditions, budgets and error handling. Never send emulator `Bearer owner` to cloud, remove loopback guards as a shortcut, reuse Production credentials or enable both v1/v2 financial writers for one dataset. Existing V2 cannot be activated on Staging by merely setting environment variables.
3. **Runtime/auth gate:** test the adapter on Node v22.23.2 with the confirmed IAD hosting context and an aligned `us-east4` test target when available. Verify target rejection, token refresh, wrong identity/channel, forged/expired/revoked sessions, cross-origin requests and direct-client denial. Pin exact test hostname/Test LIFF configuration; any new LINE/configuration work needs separate permission. Agree end-to-end deadline and same-key receipt recovery for unknown commit outcomes before exposing the route.
4. **Small fixture gate:** review and approve exact new synthetic paths/values before writing. Use a new run namespace, synthetic members/rewards only, no existing MB-0001 fixture and no real migration. Validate required composite indexes and pagination query behavior on the actual service; emulator success alone does not establish index readiness.
5. **Validation:** through isolated test endpoints, cover register/profile -> state/history pages -> earn -> redemption -> refresh/replay -> admin cancel/complete. Include distinct operation IDs, same-key/different-payload rejection, response loss, stale versions, missing guards, session/control ABA and no partial write. Compare points, stock/version, history, receipts and summaries after every financial case.
6. **Measured acceptance:** representative, concurrency20, burst50, shared reward20 and shared/distinct summary shards on the small sample, with explicit quota counters including retries/readback/cleanup. Apply the owner's 3s/5s/15s criteria from initial arrival through definitive resolution and zero integrity violations. A quota/deadline/unknown-state stop is not PASS. Do not import three-year archives or infer full-database performance from this sample.
7. **Stop/rollback:** on failure disable only the isolated test route and retain evidence; drain/check outstanding receipts before any approved cleanup. Existing v1 and live staging fixtures remain unchanged. Cleanup is separately scoped to the new test namespace and requires approval. No Production cutover follows automatically.

## Remaining risks and next safe action

The current remote transport, IAM/index readiness and Node22 runtime validation remain unimplemented/unverified gates for Staging, not hidden capabilities of this PASS. Full-database managed-service latency and universal 15-second resolution during network outages remain unproven. Financial receipt retention and exclusive writer ownership must remain intact in any later migration design; none is performed here.

**NEXT SAFE ACTION:** owner reviews the 28-file commit plan and separately authorizes any desired next step. This turn stops with only a new review test file/report and local evidence outputs; application source is unchanged. No commit, push, deploy, credential change, live data access or next milestone was performed.
