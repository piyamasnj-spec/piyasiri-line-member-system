# V2 capacity retest — BLOCKED / safe resume point

2026-09-22, branch staging. Continued the existing working tree; no v1 or v2 application code changed. No Production/live staging/LINE access, deployment, real migration, commit or push.

## Completed in this retest

- Added a streaming adapter around existing `planned-capacity.mjs` records, not a replacement implementation. It adds v2 indexes, consistent balances/stock/version, timestamps across 1,095 days, pending counters, and real-format operation fingerprints. Opening member points are 10,000; final reward stock is 100; historical redemptions older than 30 days have completion receipts. These are explicit synthetic assumptions, not real activity.
- Generated complete gzip JSONL archives plus count/hash manifests for 5,000 normal, 5,000 stress and 10,000 normal. Archives are outside the repository in `work/emulator-runtime/v2-capacity-data`. A fourth, 10,000 stress archive was interrupted at the safe usage-limit stop; its `.partial` file is invalid and must not be imported.
- New generator correctness tests: 4/4 PASS (record/index/receipt counts, ledger-to-balance and summary consistency, actual v1 fingerprint replay, dates/unique keys).
- Actual emulator resource probe stopped safely at 240,000 documents: private memory 1,498,669,056 bytes, working set 1,456,451,584 bytes. This crossed the configured 1,400 MiB private-memory guard on the 1,536 MiB Java heap configuration. System initially had about 4.37 GiB free RAM, on a 15.28 GiB machine. This is a resource-budget stop, not an observed financial integrity failure or a measured full-envelope maximum.
- Control/writer is emitted last; the partial import never became financially enabled. Emulator has been stopped, so partial in-memory data is gone; completed archive artifacts remain.

Complete document counts (including indexes/completion receipts): 5,000 normal **1,875,054**; 5,000 stress **5,812,554**; 10,000 normal **1,890,054**. The 10,000 stress target is **5,827,554**, not yet a completed archive. Counts exceed previous lower-bound sizing because lookup indexes and historical completion receipts are now included.

## Contention diagnosis, separate from full-envelope capacity

Used the existing v2 handler/store logic with a test-only HTTP observer. No transaction policy or integrity checks changed. Both groups used 20 synthetic members on a fresh small dataset. Archive generation ran in the background, so these are diagnostic observations, not isolated benchmark/SLA results.

| Scenario | First pass | Eventual outcome | p95 | ABORTED conflicts |
|---|---|---|---:|---:|
| Distinct reward per member | 20/20 | 20 commits | 5,865 ms | 10 |
| Shared reward, stock 5 | 1 commit; 19 exhausted retries | Same-key recovery: 5 commits, 15 insufficient-stock denials | 31,138 ms initially | 239 |

Exact captured error: **`ABORTED: Transaction lock timeout.`** All observed ABORTED responses occurred at **commit**, not the document-read RPCs. Commit p95 was about 2.1 seconds, repeated across up to 12 attempts. This confirms commit lock contention as the immediate cause of retry bursts and long tails in this experiment. It is not caused by transferring a growing global history.

The same reward is a shared mutable document. Even distinct rewards share some summary shards: the 20-member fixture maps four members to shard 1, three to shard 20 and two to shard 18. These collisions are additional plausible contention sources; their individual effect has not been isolated. The implementation starts fresh readWrite transactions on retry (`retryTransaction` was never sent); changing retry priority/order is a future reviewed experiment, not a fix applied here.

Final balances, debit/redemption counts and stock were checked in both diagnostic groups; no lost update, duplicate debit or negative stock occurred after safe retry. This does not certify full-envelope behavior or eliminate availability risk.

## Not completed / not claimed

- Full-envelope 5 / 20 / 50 / same-reward20 workload tests: **NOT RUN**, because no full envelope fit within the tested emulator resource budget.
- Scope independence at full envelope: **NOT VERIFIED** this turn. Previous 32,850-history evidence remains historical and is not relabeled as full-envelope PASS.
- Relevant v2 financial/cancel-race regressions: **not rerun this turn**. Previous 80/80 milestone results remain historical. Only the four new generator tests and two diagnostic groups completed here.
- No claim that this experiment establishes the exact RAM required for millions of Firestore emulator documents. Do not extrapolate a guaranteed host size from a partial sample or raise the budget into desktop memory exhaustion.

## Safe resume steps

1. Read this document and workspace `outputs/v2-capacity-resume.json`; inspect git status. Do not recreate the three completed cases.
2. Run `node scripts/v2-capacity-envelope.mjs` from the repository when usage allows. It skips completed archive+manifest pairs and recreates only unfinished 10,000-stress output. Verify gzip/hash before use; `.partial` is not evidence.
3. Provide/authorize an isolated local test runtime with a sufficiently reviewed RAM budget for the complete datasets. Current 1.5 GiB heap crossed its safety guard at about 12.8% of the smallest case. A larger dedicated non-Production environment needs fresh resource calibration; do not substitute Production or live staging.
4. Extend the existing streaming probe/import path to load a complete archive with count/hash verification and final control enablement, then reuse/adapt the existing `test-v2-workload.mjs` scenarios to that namespace. Do not create a second financial implementation. Run the requested workload sizes and cancel/retry/idempotency regressions only after a complete load is confirmed.
5. Preserve the test-only contention observer to identify lock time by RPC phase. Any retry-policy change needs its own isolated comparison and full invariant checks; none has been authorized/applied as a shortcut to PASS.

Stopped because the user explicitly requested a safe pause near usage limits: about 14% short-window and 10% weekly usage remained at the checkpoint. No test/emulator/generator process is intentionally left running.

Evidence files in the containing workspace's outputs directory: `v2-capacity-generation.txt`, `v2-capacity-resume.json`, `v2-capacity-resource-probe.json` / `.txt`, `v2-capacity-contention.json` / `.txt`, `v2-capacity-envelope-tests.txt`. New repository files: three scripts (`v2-capacity-envelope.mjs`, `probe-v2-capacity.mjs`, `diagnose-v2-contention.mjs`), `tests/v2-capacity-envelope.test.mjs`, and this document. All existing application source remains unchanged.

## Resume inspection checkpoint — 2026-09-23

Read the existing resume and inspected the current staging working tree and archive inventory. No generator, emulator, workload or regression run was started in this continuation. No application source was changed.

Completed archive sizes remain: 5000-normal 111326613 bytes; 5000-stress 345090799 bytes; 10000-normal 111903269 bytes. The unfinished 10000-stress.jsonl.gz.partial is 43089249 bytes and remains unverified; do not count it as completed evidence. No completed dataset was regenerated.

Paused before starting a new work chunk because the account weekly usage window has approximately 8% remaining, following the user's explicit near-limit safe-stop instruction. Previous test results remain historical, not newly rerun results.

Pending work is unchanged: finish only the fourth archive (evaluate partial recovery safely), independently verify archive counts/hash, evaluate a memory-bounded proof strategy, run missing workloads and relevant regressions. Partitioned/offline validation must not be presented as proof of full-envelope emulator query/latency behavior unless that claim is actually established. Do not raise or bypass the memory guard. Existing resource and contention blockers remain unresolved. Resume this same milestone when usage permits; no Production or live staging access is required or authorized.

## Latest checkpoint — 2026-10-01 (supersedes earlier pending-work lists)

STATUS: BLOCKED only for full-envelope capacity certification / availability evidence.

- All FOUR archives now complete. Only unfinished 10000-stress was regenerated; the original three were skipped and retained September 22 timestamps/sizes. The fourth has 5,827,554 documents, 2,292,808,044 uncompressed bytes and SHA-256 e46a12bc499ee02064150a1fe90908affaf422bec8a55a939e3d0e69dae3d7ab. No partial remains.
- Independently streamed all four gzip archives: CRC, SHA, byte/count manifests and per-member ledger balances PASS. Peak sampled verifier RSS 113,479,680 bytes. Do NOT regenerate any archive on resume.
- Reused existing workload: representative 5/5 first attempt; concurrent20 16/20 first +4 safe recoveries; burst50 46/50 first +4 safe recoveries; sameReward20 5 commits/15 stock denials. Integrity PASS. Additional 0/32850 retained-history scope test identical 8 reads/6 writes/2197 logical bytes/4000 commit bytes. These are representative fixtures, NOT a full database import.
- Five contention diagnostics passed final integrity. Distinct rewards/distinct summary shards: 0 conflicts, p95 215ms. Distinct rewards/one shard: 212 conflicts, p95 29757ms, 13 external retries. Shared reward/distinct shards: 178 conflicts, p95 24642ms. Captured ABORTED errors occur at commit: Transaction lock timeout. No application retry policy changed.
- Relevant regressions newly rerun: 84/84 PASS, no skips, including failure-before-commit, response-loss retry, key/payload mismatch, concurrent balance protection and cancel/complete race.
- Emulator guard unchanged and not hit: peak sampled private 799907840 bytes; minimum system free 5527740416 bytes. Runner finished all stages exit 0 and stopped its emulator. No generator/test process remains intentionally running.

Full database/index/query latency remains unmeasured. Streaming validates the complete archive and bounded financial application scope, but disjoint partitions remove combined index/cache footprint and can remove shared contention. They cannot certify full-envelope performance of the unchanged architecture. Do not relabel this result PASS or retry the known unsafe full import on this desktop.

NEXT SAFE ACTION: obtain an explicitly authorized isolated synthetic-only test runtime with a reviewed resource budget (or an isolated non-Production Firestore project with permissions/cost limits), and agreed latency/retry criteria. Reuse verified archives, calibrate safely, verify full import counts, then run full-database workloads. Do not repeat completed representative tests without a changed input or unresolved failure. No Production/live staging/RTDB v1 changes, deployment, commit or push.

Detailed report: work/member-system/docs/V2_CAPACITY_RETEST_RESULTS.md. Raw current evidence: outputs/v2-capacity-archive-verification.json, v2-capacity-retest-run.json, v2-workload.json, v2-capacity-contention.json, v2-retest-regressions-20261001.txt. Previous result JSON preserved under before-20261001-*.
