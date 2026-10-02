# V2 capacity retest — 2026-10-01

Status: **BLOCKED for full-envelope capacity certification**. This continuation uses the existing staging working tree and unchanged V2 financial implementation. No Production/live staging access, real migration, deployment, credential change, commit or push.

## Complete offline envelope evidence

The existing generator skipped all three completed archive/manifest pairs. Only the incomplete 10,000-stress gzip was regenerated: its interrupted deflate stream had no resumable checkpoint or completed trailer, so appending was not safe. All four archives were then independently decompressed and checked against their manifests. Gzip CRC, uncompressed SHA-256, byte counts, collection counts, final writer-control position and each member's opening 10,000 points plus ledger deltas passed. This is synthetic evidence, not real-data certification.

| Members / case | Documents including indexes/receipts | Uncompressed JSONL bytes |
|---|---:|---:|
| 5,000 normal | 1,875,054 | 731,503,462 |
| 5,000 stress | 5,812,554 | 2,289,333,842 |
| 10,000 normal | 1,890,054 | 734,957,914 |
| 10,000 stress | 5,827,554 | 2,292,808,044 |

Each case covers 1,095 days; normal is 500 earns/50 redemptions per day, stress is 1,500/200. The streaming verifier retains only per-member totals and collection counters, not millions of records. Peak sampled Node RSS was 113,479,680 bytes (about 108.2 MiB); largest JSON document was 610 bytes. JSONL size is not a measurement of Firestore storage/index billing or emulator heap requirements.

Evidence: workspace `outputs/v2-capacity-archive-verification.json`, `outputs/v2-capacity-generation-continuation.txt`; complete archives/manifests in `work/emulator-runtime/v2-capacity-data` outside the repository. The three original archives retain their September 22 timestamps and sizes.

## What bounded testing establishes, and what it does not

The actual financial implementation loads documents by exact identity/bill/receipt IDs. Financial transactions cannot query collections: `firestore.mjs` permits queries only in read-only transactions. It enforces at most 20 distinct document paths and 512 KiB logical payload before commit. Retained transactions and receipts are individual documents, not arrays embedded in a customer or summary. Adding unrelated retained records therefore does not introduce an application-level global-history read into a normal financial operation.

The existing scope experiment was rerun: 0 versus 32,850 historical transactions spread across all 1,095 days both used 8 reads, 6 writes, 2,197 logical bytes and 4,000 commit bytes. This verifies the selected operation and bounded application scope; it is not a full-envelope database latency test.

Member-state queries filter by customer and use bounded pages/cursors (maximum query page 26 documents; read-only transaction budget 180 documents/1 MiB). A bounded result does not prove that backing query/index execution at millions of stored documents meets a latency target.

Streaming proves complete archive content can be processed within the desktop budget. Loading disjoint history partitions into separate namespaces or restarting between partitions removes the combined database/index/cache footprint. Partitioning members or rewards also changes their contention graph. Neither method, by itself, certifies the unchanged full database's query latency, indexing, memory usage or sustained availability. We did not relabel these methods as full-envelope PASS or alter application schema to make a test fit.

The previous full-load probe stopped at 240,000 documents under the 1,400 MiB private-memory guard, far short of the smallest 1,875,054-document archive. That guard and the 1,536 MiB heap limit were preserved. The full load was not repeated because there is no new evidence that it can safely fit. No guaranteed RAM requirement is extrapolated from that partial sample.

## Workload, contention and regression results

These workloads use representative fixtures, not a fully loaded archive. Generation and streaming verification completed before the emulator workloads began.

| Workload | First attempt | Same-key external recovery | p95 ms | Integrity |
|---|---|---:|---:|---|
| Representative 5 | 5/5 | 0 | 638 | PASS |
| Concurrent 20 | 16/20 | 4 recovered | 29,430 | PASS |
| Burst 50 | 46/50 | 4 recovered | 29,063 | PASS |
| Same reward 20, stock 5 | 5 commits / 15 stock denials | 0 | 14,092 | PASS |

The first three cases use 5,000 members and 1,650 retained transactions each. Workload financial requests used at most 8 reads, 6 writes, 2,212 logical bytes and 4,010 commit bytes. The 0/32,850 history comparison is an additional fifth scenario. A failed first attempt means retry exhaustion with `transaction_busy_retry_same_key`; eventual recovery must not be reported as first-attempt availability.

Five separate diagnostic groups use the same financial implementation and an HTTP timing observer:

| Diagnostic, 20 requests | First commits | External retries | p95 ms | ABORTED conflicts |
|---|---:|---:|---:|---:|
| Distinct rewards, default shard collisions | 20 | 0 | 4,573 | 11 |
| Shared reward, default shard collisions | 3 | 17 | 29,349 | 225 |
| Distinct rewards, 20 distinct summary shards | 20 | 0 | 215 | 0 |
| Distinct rewards, one summary shard | 7 | 13 | 29,757 | 212 |
| Shared reward, 20 distinct summary shards | 5 | 0 | 24,642 | 178 |

Both shared-reward groups eventually have exactly 5 commits and 15 insufficient-stock denials. Distinct-reward groups eventually commit all 20. Customer balances, debit/redemption row counts, stock/version and summary totals passed in all groups. The last three groups each contain 1,024 synthetic members, with the selected member cohort chosen by the existing shard hash. No shard routing or application retry implementation was changed.

All captured ABORTED responses were `Transaction lock timeout.` at commit; none were read-RPC aborts. Commit p95 is about 2.03 seconds in contended groups. These measurements demonstrate that a shared summary shard can cause contention without a shared reward, and a shared reward can cause contention with distinct summary shards. They are single sequential diagnostic runs, not repeated statistical benchmarks or production SLA measurements. Registration in the mixed burst also shares the member-code counter; the shard experiment does not establish the cause of every mixed-workload retry.

Retries currently begin fresh read-write transactions; the observer saw zero `retryTransaction` options. This is an observation for later review, not proof that changing this option alone fixes contention.

Evidence: `outputs/v2-workload.json`, `outputs/v2-capacity-contention.json` and their dated `v2-retest-*-20261001.txt` logs. Previous JSON results were preserved under `outputs/before-20261001-*`.

Relevant regressions: **84/84 PASS, zero skipped** (25 V2 emulator integration tests, 4 envelope-generator tests, 55 existing transport/redemption/security/shared-writer regressions). These cover no lost updates/overspend, no duplicate debit, nonnegative limited stock, failure-before-commit with no partial mutation, same-key payload mismatch, response-loss retry, idempotency, cancellation refunds and cancel/complete races. The existing RTDB v1 source was not modified.

The local runner preserved the 1,400 MiB private / 1,536 MiB working-set thresholds, 1,536 MiB minimum system-free guard and 1,536 MiB Java heap. It sampled every three seconds and would stop its own child processes on a breach. Observed peak Java private memory was 799,907,840 bytes (762.9 MiB), peak working set 729,325,568 bytes, and minimum system free memory 5,527,740,416 bytes. All three runner stages exited 0; the guard did not trip and the emulator was stopped. These are sampled measurements, not absolute instantaneous maxima. Evidence: `outputs/v2-capacity-retest-run.json`.

Files added/changed in this continuation: new `scripts/verify-v2-capacity-archives.mjs`, extended test-only `scripts/diagnose-v2-contention.mjs`, this report and the resume document. Workspace outputs include the local guarded runner, raw results/logs, preserved previous results and updated machine-readable resume; one archive/manifest pair was completed outside the repository. No application source, RTDB v1, Rules or deployment configuration changed. No commit or push.

## Remaining gate and next safe action

Full-envelope database performance remains unmeasured. Provide an explicitly authorized, isolated non-Production test runtime with a reviewed resource budget, or an isolated synthetic-only Firestore test project with explicit cost limits and test permissions. Reuse the four verified archives; calibrate resources safely and record complete import counts before running the unchanged workload on the full database. Do not load real customer data, reuse live staging, raise this desktop's guard, or deploy anything as part of this result.

Define an acceptable latency/first-attempt success/retry budget before certifying availability. Commit lock timeouts and successful same-key recovery are distinct from financial-integrity failure; preserving balances does not establish acceptable user-facing latency. No application retry policy was changed in this milestone.
