# V2 local contention optimization — $0

2026-10-02 — **STATUS: PASS for the LOCAL CONTENTION milestone only.** Branch `staging`; no commit/push/deploy, cloud resources, Production/live-staging access, real migration or RTDB v1 changes. No three-year archive was generated or loaded. All four completed archives remain untouched.

## Acceptance and measured scope

Owner-approved gates: normal p95 <=3 seconds; concurrent/burst p95 <=5 seconds; definitive outcome within 15 seconds for conflicted/retried operations; all tested financial invariants correct.

Three fresh emulator runs passed **all 27 scenario groups / 585 measured logical operations**, including correct out-of-stock denials. Every group met its p95 gate. Maximum observed end-to-end latency was **3,244 ms**, including internal retries; no external recovery call was needed. Timing begins before invoking each operation and includes waiting plus same-key external recovery if any. Verification/replay calls are additional integrity checks, not included as extra throughput samples. This is finite local evidence, not a p99/production availability guarantee.

## Change and integrity argument

The application paths, UI/API, receipt keys, financial calculations, document budgets and **32 summary shards** are unchanged. Only V2 local transport and batching changed:

1. Read a consistent **read-only snapshot**, retaining the exact `updateTime` for every found document and `exists:false` for every absent document. Missing version metadata fails closed.
2. Release the snapshot, then send **one atomic Firestore Commit**. Every changed/deleted document has its recorded version precondition. Every read-but-unwritten document has a `verify` operation, including writer control, session/identity guards and absent records. At most 20 unique financial documents participate; a path is represented once, as a mutation or verification.
3. A stale precondition rejects the entire commit. Retry the callback with a fresh snapshot after bounded randomized backoff (20–499 ms). Handle commit-phase `FAILED_PRECONDITION`, `ALREADY_EXISTS`, `NOT_FOUND`, and `ABORTED`; do not reinterpret non-commit precondition failures as write races. Existing maximum attempts remains 12.
4. Unknown commit outcomes are not blindly retried by the transport. Existing same-operationId receipt recovery remains the required way to resolve a lost response. It is incorrect to label a timeout as proof that no commit occurred.
5. Batch already-known document paths in `member-store.mjs` instead of fetching each individually. All validations and reads remain within the snapshot and covered by commit preconditions.

This avoids pessimistic read-to-write lock upgrades without introducing process-local serialization, a distributed lock service, new schema or migration. Checking only modified documents would be unsafe; the unchanged and missing read guards are essential. If any document changes between snapshot release and commit, the atomic preconditions stop the stale write. Concurrent limited-stock redemptions cannot both commit against the same reward version. Customer balance, stock, ledger, redemption, receipt and summary still change together. Snapshot-only operations keep their consistent read behavior.

The approach follows the Firestore client's optimistic read-version/verification pattern; it does not use `batchWrite` or disjoint updates. Sources: [Firestore client transaction implementation](https://github.com/firebase/firebase-js-sdk/blob/master/packages/firestore/src/core/transaction.ts), [atomic Commit API](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/commit).

## Investigation retained

The previous transport used read-write transactions, sequential reads and narrowly jittered retry. Captured failures occurred at commit with `Transaction lock timeout.` Sending `retryTransaction` alone did not solve it (shared reward p95 30,761 ms). Batched reads plus wider pessimistic backoff also failed (shared shard p95 36,586 ms). These intermediate variants are **not** the final implementation. Their reports are preserved in workspace outputs as `v2-contention-retry-lineage-only.json` and `v2-contention-batched-pessimistic.json`.

The optimistic pilot removed lock timeouts. Regression then exposed missing retry handling for `ALREADY_EXISTS` on concurrent creation; the commit was rejected safely, but the caller did not yet recover. That defect was fixed and the entire relevant regression suite rerun successfully. The initial failure log is retained, not silently discarded.

## Before / after

Historical BEFORE is the previously recorded local baseline. AFTER shows the range of end-to-end p95 across three final runs, never a pooled percentile. Earlier baseline p95 excluded subsequent external recovery, so its latency understates total time where recovery was necessary. Environment/load history is not an identical controlled cloud benchmark.

| Scenario | Before p95 ms | After p95 ms (3 runs) | Before conflicts | After conflicts (3 runs) | External retries before -> after |
|---|---:|---:|---:|---|---|
| Representative 5 | 638 | 653–700 | 0 | 0 / 0 / 0 | 0 -> 0 |
| Concurrent 20 | 29,430 | 1,062–1,247 | 62 | 7 / 7 / 7 | 4 -> 0 |
| Burst 50 | 29,063 | 2,416–2,829 | 125 | 44 / 40 / 40 | 4 -> 0 |
| Same reward 20, stock 5 | 14,092 | 879–1,014 | 106 | 50 / 50 / 50 | 0 -> 0 |
| Distinct rewards, normal shard mapping | 4,573 | 681–712 | 11 | 9 / 10 / 8 | 0 -> 0 |
| Shared reward, normal shard mapping | 29,349 | 1,100–1,253 | 225 | 52 / 53 / 55 | 17 -> 0 |
| Distinct rewards / distinct shards | 215 | 214–246 | 0 | 0 / 0 / 0 | 0 -> 0 |
| Distinct rewards / one shared shard | 29,757 | 1,863–2,487 | 212 | 76 / 76 / 72 | 13 -> 0 |
| Shared reward / distinct shards | 24,642 | 928–1,073 | 178 | 52 / 48 / 49 | 0 -> 0 |

AFTER internal retry counts equal the listed conflict counts; all resolved inside the original external call. The BEFORE conflicts were lock-timeout aborts; AFTER diagnostic conflicts are immediately rejected stale versions. **Zero transaction lock timeouts** were captured across the final diagnostics. Non-contentious latency is essentially unchanged; the improvement is in contended writes.

## Integrity, bounded scope and regressions

- **98/98 relevant regression tests PASS**, no skips/failures: prior 84 tests, 4 new real-emulator interleaving tests, 10 new offline transport/retry tests. The suite contains 29 V2 emulator integration tests; the whole 98 must not be described as 98 emulator cases.
- Existing tests still prove exact receipt replay/key-payload rejection, response-loss retry, failure before commit, simultaneous distinct operation IDs, no lost points, no duplicate debit, no negative stock, no partial mutations and safe cancel/complete races.
- New deterministic two-client interleavings change writer control or revoke an admin session after the snapshot, create a previously absent guard, and modify a delete target. Each stale commit is rejected atomically; retries see the new state. These explicitly cover read-only/absent guards and delete version checks.
- Each stock-5 contention case yields exactly 5 commits and 15 stock denials. Balances, stock/version, transaction/redemption counts, receipts and summary totals reconcile.
- Final workload financial scope stays at at most **8 read documents / 6 mutated documents / 2,212 logical bytes**. Maximum measured serialized commit is **4,520 bytes** (previously 4,010): the small increase carries version preconditions and verification operations, not retained history. Guards remain 20 distinct documents / 512 KiB logical financial payload. Full three-year scope evidence is reused, not rerun or regenerated.

## Runtime and reproduction

Used the existing portable Java 21 emulator 1.22.0 and local Node **v24.19.0**. This is not an execution test of the confirmed Netlify Node v22.23.2 runtime. Emulator listens only on `127.0.0.1:8085`, project `demo-member-v2`; V2's remote/Production guard remains in place. No service account or real customer data was used.

Reused the previous guarded runner, adapted in workspace `outputs/run-v2-contention-local.mjs`. Run it from the workspace root with the existing portable Node. It starts/stops only its own emulator, runs the existing workload/diagnostic scripts with `--contention-review` (which skips the already-completed retention generator), and runs the relevant suite. Optional argument `workload,contention` repeats only timing groups. The runner preserves the prior baseline and reports child failures as a nonzero exit.

Final relevant suite: `node --test tests/v2-integration.test.mjs tests/v2-retry.test.mjs tests/v2-capacity-envelope.test.mjs tests/transport.test.mjs tests/reward-redemption.test.mjs tests/security.test.mjs tests/shared-writers.test.mjs`, with the runner's explicit local-emulator test environment. The four tiny envelope unit tests were reused; no archive regeneration occurred.

Desktop safety limits were unchanged. Final runs sampled peak emulator private memory **706,658,304 bytes (~674 MiB)** and minimum system free memory **6,810,718,208 bytes (~6.34 GiB)**. All final stages exited 0; all three emulator processes were stopped. No memory guard was bypassed.

## Files and evidence

Repository files changed this milestone:

- `netlify/functions/lib/v2/firestore.mjs`
- `netlify/functions/lib/v2/member-store.mjs`
- `scripts/test-v2-workload.mjs`
- `scripts/diagnose-v2-contention.mjs`
- `tests/v2-integration.test.mjs`
- `tests/v2-retry.test.mjs` (new)
- `docs/V2_LOCAL_CONTENTION_RESULTS.md` (new)

Workspace evidence: `outputs/v2-local-contention-comparison.json` includes source hashes and all three measurements. `outputs/v2-local-contention-run1/`, `run2/`, `run3/` retain workload, diagnostics and resource reports; run1 also contains the final 98-test log. The previous source/results are in `outputs/before-local-contention-20261002/`. Intermediate pilot evidence and the initial regression failure are also retained. Logs/runtime artifacts are local evidence, not deployment assets.

## Remaining limits and next action

No blocker remains for the **tested local contention acceptance criteria**. Cost incurred: **$0**. This result supersedes the local latency blocker in the zero-cost review; it does not certify full-database managed-service performance, Netlify/Node 22 latency or a universal 15-second resolution under network outage. The existing transport timeout/attempt limits are not a hard 15-second API deadline, and unknown network outcomes still require receipt reconciliation with the same key.

**NEXT SAFE ACTION:** review the V2-only diff and this local evidence. Stop here; no cloud run, Production readiness claim, deployment, migration or next milestone is authorized by this PASS.
