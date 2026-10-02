# V2 capacity: zero-cost-first evidence review

2026-10-02 — **STATUS: BLOCKED for complete capacity/availability sign-off.** Bounded transaction scope, synthetic retention integrity and tested financial correctness have sufficient existing evidence. A multi-million-document cloud benchmark is **not a prerequisite for those conclusions**. No cloud resource or paid execution is authorized. This strategy supersedes execution recommendations in the earlier isolated plan and cost preflight; their estimates remain historical planning information.

## Validation performed now ($0)

Ran `scripts/audit-v2-free-capacity.mjs` with local Node v24.19.0 and a 128 MiB Node heap limit: **9/9 offline audit checks PASS**, exit 0. It reads existing JSON reports/manifests and archive file metadata, verifies evidence consistency, and executes the current pure summary-shard function against 5,000 and 10,000 synthetic member IDs. Output: workspace `outputs/v2-free-capacity-audit.json`.

These are evidence-audit checks, not nine new financial integration tests. No archive regeneration, full archive rehash, emulator startup, repeated benchmark or regression suite was needed. No application code changed, so the recorded **84/84 regression PASS** remains reused historical evidence, not a new run or Node 22 runtime result. No database, credentials, Production or live staging access occurred.

## Evidence reused and what it establishes

| Evidence | Conclusion | Limit |
|---|---|---|
| Four complete archives; largest 5,827,554 documents / 2,292,808,044 JSONL bytes | Full planned synthetic 3-year data representation exists | JSONL bytes are not billed Firestore/index storage |
| Previous full streaming CRC/hash/count/balance verification, all four PASS | Complete archive integrity without memory proportional to history | Does not exercise database indexes/cache |
| Real emulator scope at 0 versus 32,850 retained history rows | Both 8 reads / 6 writes / 2,197 logical bytes / 4,000 commit bytes | Two measured points, not a full database latency test |
| Current transport and member-state inspection | Financial reads target keys, queries prohibited in financial transactions; 20 distinct-document / 512 KiB logical budget. State uses customer-filtered cursor pages, at most 26 fetched per collection, 180-document / 1 MiB read budget and 256 KiB response guard | Payload bounds do not guarantee server query latency or index scan cost |
| Prior 84/84 regressions | Tested pagination/ownership, atomicity, idempotency, response-loss retry, no partial mutation and cancel/complete race | Emulator/local scope |
| Prior workload and contention runs | Final balances, stock and receipts remain correct after conflicts/recovery | Availability/latency concerns persist |

The 8 MB RTDB root guard is no longer a V2 history-size transaction constraint. Retained history need not be imported in full to validate application document/payload bounds. No RTDB v1 code or limits were changed.

## Contention analysis, without rerunning failing workloads

Historical observations:

| Case | First external call / outcome | Recorded p95 |
|---|---|---:|
| Representative 5 | 5/5 success | 638 ms |
| Concurrent 20 | 16/20 success; 4 safe same-key recoveries | 29,430 ms |
| Burst 50 | 46/50 success; 4 safe same-key recoveries | 29,063 ms |
| Distinct rewards, distinct summary shards | 20/20; zero conflicts | 215 ms |
| Distinct rewards, one summary shard | 7/20 initially; 13 safe recoveries; 212 conflicts | 29,757 ms |
| Same reward, distinct shards | 5 commits / 15 stock denials; 178 conflicts | 24,642 ms |

These durations are the recorded initial-call measurements, not end-to-end percentiles including external recovery. Small samples cannot substantiate p99 or a 99.5% availability claim. Existing plan thresholds were **proposed**, not owner-approved SLAs; failures cannot be silently removed by declaring the shop small.

New offline calculation uses the real shard function. The 5,000-member population occupies all 32 shards, 130–184 members/shard; 10,000 occupies 277–352/shard. With uniformly sampled distinct members, expected same-shard pairs are approximately **0.313 at concurrency 5, 5.95 at 20, 38.34 at 50**. Formula: `choose(concurrency,2) * sum(n_s*(n_s-1))/(N*(N-1))`. These are potential shared-document pairs, **not predicted abort counts, latency or observed shop traffic**. Hot-member/reward skew needs separate scenarios. The distribution is not grossly collapsed; increasing members does not eliminate shard sharing. Do not change shard count based on this calculation alone.

Firestore explicitly documents emulator transaction differences and possible lock-release delays up to 30 seconds. This is consistent with, but does not prove the sole cause of, our captured commit lock timeouts. Neither emulator failure nor success predicts managed-service latency. [Official emulator limitations](https://firebase.google.com/docs/emulator-suite/connect_firestore#how_the_cloud_firestore_emulator_differs_from_production).

## Small-shop acceptance without importing three years to cloud

A proportionate evidence package can combine the already completed full offline archive verification and scope bounds with a **small indexed service sample** and controlled contention tests. Use representative/skewed member history, cursor ties and deeper pages, same reward and same summary-shard cohorts; retain all financial integrity gates. Millions of unrelated documents need not be copied merely to repeat atomicity checks. Any sign-off must explicitly exclude an unmeasured full-database latency SLA.

We can close **logical bounded-capacity evidence** now. We cannot close overall V2 capacity/stabilization from current evidence: the required concurrency 20 / burst 50 / same-reward cases still lack acceptable availability evidence. The single representative 5 case is promising but insufficient to certify a smaller sustained operating envelope. No reduction of the owner's envelope, production launch, architectural change or risk waiver is implied.

## Optional free-quota sample: calculated, NOT executed

Official quota checked 2026-10-02: one free Firestore database per project; 1 GiB stored, 50,000 document reads/day, 20,000 writes/day, 20,000 deletes/day, 10 GiB outbound/month. Daily reset is around midnight Pacific. Paid features such as TTL deletes/PITR/backups are excluded. [Firestore quotas](https://firebase.google.com/docs/firestore/quotas), [billing details](https://firebase.google.com/docs/firestore/pricing).

Candidate **single isolated day**, no other project traffic, existing archives sampled rather than regenerated:

- Import at most 5,000 documents and read each back once: 5,000 writes + 5,000 reads.
- At most 50 financial calls, no external retries, max 12 internal attempts and conservative 20 documents per attempt: reserve 12,000 reads and 12,000 write attempts. Counting failed write attempts as writes deliberately overestimates the chargeable total.
- At most 50 state calls, each capped at 180 reads, **one attempt per read call**: reserve 9,000 reads. If read retries are enabled instead, this calculation is invalid; stop/rebudget.
- Totals: <=17,000 conservative writes, <=26,000 document reads. Reserve up to 10,000 additional billed read units for indexes/empty queries, giving <=36,000 read units. Query shape/index billing must be checked before use; a returned-document limit alone does not bound index reads.
- <=6,000 distinct documents to delete (5,000 imported + at most 20 new documents for each of 50 commits). No TTL cleanup. Separate conservative storage ceiling 0.25 GiB **including indexes**, outbound ceiling 0.1 GiB; these must be measured/enforced rather than inferred from gzip size.

This tiny run is an initial service diagnostic, not a statistically sufficient full benchmark. Additional cohorts may be spread across quota reset days only after accounting for retained storage and all usage. It would require an explicitly approved isolated project with billing disabled, verified free-database eligibility, no paid services, and a separately reviewed test-only authenticated transport; current V2 transport intentionally accepts emulator loopback only. Local operation counters must stop before caps and account for retries/readback/cleanup. **A free quota on a billing-enabled project is not a hard $0 guarantee.** No such project, transport, credentials or resources were created/used this turn; do not implement this proposal until its no-charge prerequisites are verified and authorization is obtained.

## Decision and next safe action

**BLOCKED only on availability/performance sign-off within this capacity review**, not on archive completeness or logical transaction scope. The free review has reached its evidentiary limit; repeating unchanged emulator workloads or loading the complete archive on this desktop adds no useful proof and risks the known memory guard.

Next safe action: agree the small-shop latency/retry acceptance envelope and whether a scoped capacity conclusion (bounded logic PASS, full-history service latency explicitly unproven) is acceptable. If actual service evidence is required, review eligibility for the above billing-disabled free-quota diagnostic before authorizing any resource or test-only transport. No $30–$60 benchmark is required or recommended as the immediate step. No step in this document authorizes Production access/deployment or starts the next milestone.
