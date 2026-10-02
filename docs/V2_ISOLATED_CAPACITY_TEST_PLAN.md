# Isolated synthetic-only V2 capacity benchmark plan

2026-10-01 — **PLAN READY; IAD/Node 22 configuration review CLOSED; execution is not authorized or ready yet.**

Owner-confirmed active Production configuration: Functions **IAD (N. Virginia, US East)**, Node runtime/build **v22.23.2**, deploy **main@eae491d**, **6 functions deployed**. This is owner-supplied metadata; no Production access or main checkout was performed. It does not imply that local V2 is deployed. This update supersedes the earlier provisional Singapore pricing/locality.

Reviewed the current staging working tree, `V2_CAPACITY_RETEST_RESULTS.md`, the latest October 1 checkpoint in `outputs/V2_CAPACITY_RETEST_RESUME.md`, V2 transport, workload and index configuration. Existing evidence remains unchanged: four verified archives, representative integrity/workloads PASS, regressions 84/84 PASS; full-database performance and contention latency remain BLOCKED. This document changes no application, credentials, environment, dataset or architecture.

## 1. Recommended environment and execution prerequisites

Use a NEW, dedicated synthetic-only **managed Firestore Standard/Native test project in `us-east4` (Northern Virginia)**, independent of Production and `piyasiri-member-staging`, with a runner in `us-east4` pinned to **Node v22.23.2**. This aligns geographically with Netlify IAD. Record the database concurrency mode before testing. No Netlify or LINE deployment is required. Same-region GCE results remain backend-only: they do not certify Netlify cold starts or the AWS-to-GCP/Thai mobile network path.

Reason: Firebase documents that the emulator differs in transaction behavior, can have slow concurrent writes, does not enforce compound indexes and does not enforce all service limits. More emulator RAM alone cannot establish managed-service latency or index readiness. [Firebase emulator differences](https://firebase.google.com/docs/emulator-suite/connect_firestore#how_the_cloud_firestore_emulator_differs_from_production).

Minimum **runner allocation**, not a proven database RAM minimum: **4 vCPU, 8 GiB RAM, 50 GiB SSD**. The concrete priced choice is Linux **e2-standard-4 (4 vCPU /16 GiB)** with 50 GiB zonal SSD in `us-east4`, streaming import/readback, bounded batches and no full archive materialization. Managed Firestore owns database memory; 2.29 GB JSONL does not specify a service RAM requirement. Start with one complete case per test namespace. Four immutable source archives remain local/read-only and are reused, never regenerated.

Before execution, require:

- Owner-approved exact test project/database ID in `us-east4`, isolation and monetary ceiling. Configuration alignment is resolved; a fresh project remains a proposal, not an existing authorized target.
- Separate test identity with access only to that project/database and no Production/live-staging roles. Short-lived credentials on the runner; no secrets in source, reports or browser. No reuse/rotation of existing credentials.
- Runner destination allowlist for the exact project/database; reject unknown IDs, live staging, Production and RTDB before sending requests. No real LINE/OA hooks, sheet sync, notifications or ProMaxx integrations.
- Current `firestore.mjs` accepts only `demo-member-v2` at `127.0.0.1:8085` and uses emulator-only authentication. **It cannot run against managed Firestore unchanged.** A separately approved test-only transport seam/adapter is required, preserving transaction callbacks, REST transaction semantics, document budgets, retry policy and schema. Never just relax the existing emulator guard or send emulator `Bearer owner` to a remote service. Run adapter parity/security regressions before a full import. This work is explicitly deferred.
- Review and provision the existing proposed indexes only in the new test project after explicit permission, wait for READY, and exercise every actual member-state query. Do not deploy any configuration this milestone. A missing index blocks the benchmark rather than being silently worked around.
- Reuse existing handler/store workloads via a local synthetic-auth runner; adapt harness setup to an imported namespace. Existing `setup()` creates small fresh fixtures, so running it unchanged does NOT exercise a full archive. Record the exact working-tree file hashes, not just HEAD, because V2 files are currently untracked.

This phase measures V2 backend/handler latency with synthetic identity, not live LINE/LIFF or Netlify E2E.

## 2. Archives and import strategy

| Case | Documents | Uncompressed JSONL bytes |
|---|---:|---:|
| 5,000 normal | 1,875,054 | 731,503,462 |
| 5,000 stress | 5,812,554 | 2,289,333,842 |
| 10,000 normal | 1,890,054 | 734,957,914 |
| 10,000 stress | 5,827,554 | 2,292,808,044 |

Use existing archive/manifest hashes. The four source archives total about 0.914 GB compressed / 6.05 GB JSONL and 15,405,216 documents. Do not simultaneously import all cases to an in-memory emulator. Managed-service cases may remain in isolated namespaces; queries must stay scoped to the selected namespace. They must never be merged into one artificial member/history population.

Stream batches of at most 200 documents with bounded in-flight requests, initially 100 document writes/second, then 200 after healthy calibration. Only raise to at most 500 after checking latency, failures, cost and key distribution. Count document operations rather than HTTP batches. Do not exceed the gradual traffic ramp guidance for new collections. [Firestore best practices](https://firebase.google.com/docs/firestore/best-practices#ramping_up_traffic).

Keep financial access disabled while importing; defer `control/writer` until verification finishes. Persist archive hash, committed chunk offset, namespace, document counts and per-chunk digests. On uncertain import responses, read back the same IDs and compare payloads; never overwrite a mismatching existing document. Verify all imported payloads using a streaming bounded readback/digest procedure, collection counts and ledger/summary totals. The delayed control document must be explicitly accounted for. Only then enable the synthetic namespace. Do not infer import completion from attempted writes.

Use a manifest for all benchmark-added IDs and before-images. Initial tests use existing baseline member balances/reward stock. For repeatable stock-5 or fresh-reward cases, add explicitly tagged test records or controlled test-only before-images in this disposable namespace; never change source archives or existing live-staging fixtures. Prepare equivalent starting states outside the timing window and verify summaries. Any restoration is confined to allowlisted benchmark IDs, with zero in-flight requests. Cleanup/deletion requires a later explicit scope; no broad project/database deletion is implicit in this plan.

## 3. Proposed acceptance criteria — owner approval before execution

These are recommended shop-facing targets, not previously agreed SLAs or measured guarantees. Measure complete logical operations from arrival at the runner/handler to definitive response, including queue time, internal retries and any same-operationId external retries. Also report database RPC time separately. Do not reset the latency clock on a retry or exclude failures from the latency population.

| Operation / load | p95 | p99 / deadline |
|---|---:|---:|
| Member/profile state read; paginated history | <= 1 s | p99 <= 2 s |
| Earn points / profile write | <= 2 s | p99 <= 5 s |
| Redemption under normal mix / 20 concurrent | <= 3 s | p99 <= 5 s |
| Burst 50; shared reward or summary shard, 20 concurrent | <= 5 s | p99 <= 10 s; all resolve within 15 s |
| Replay of an already committed operation | <= 1 s | p99 <= 2 s |

At normal/20-concurrent load: >=99.5% of eligible operations resolve on the first external call, and >=99.9% within the operation-specific deadline including bounded retries. Burst/adversarial contention: >=99% resolve on the first external call, 100% within 15 s across the tested finite trials. Correct stock/points denials count as resolved business outcomes, not infrastructure errors; record their latency and counts separately. No uncategorized error may be hidden as a denial.

Internal attempts: proposed normal-load p95 <=2, stress p95 <=5. Report retries/operation, ABORTED rate and exhaustion independently. An outer recovery policy may retry the SAME key/payload at most twice with jitter, within the original total deadline; never overlap a timed-out uncertain request with a new operation ID. Existing calls can exceed these proposed deadlines: record that as failure, not permission to change retries mid-benchmark. Drain in-flight writes and check receipts after a deadline before preparing the next trial.

Absolute financial gates: zero lost updates, duplicate debit, negative limited stock, partial mutations, identity/payload mismatch acceptance or incorrect cancel/complete outcome. Exact final balances, stock/version, debit/redemption counts, operation receipts and shard totals must reconcile. Verify response-loss retry and before-commit fault cases. A financial violation stops the run immediately regardless of throughput.

Preserve current logical limits: financial <=20 document paths /512 KiB; state <=180 documents /1 MiB and response <=256 KiB. Compare the SAME operation/member payload across retention sizes; unrelated history must not increase its financial read/write set. Individual numbers such as 8 reads/6 writes are measurements for a request shape, not universal limits.

## 4. Benchmark matrix and sample discipline

Run complete datasets in increasing order: 5k normal, 10k normal, 5k stress, 10k stress. Preserve each result independently. Full-envelope PASS requires complete import evidence and the defined workloads on the actual full namespace, not disjoint history partitions.

1. **Reads:** member/profile reads use the existing member-state path; do not invent a profile GET API. Sample many members, including high/low historical counts. Separate first-touch from repeated reads; first-touch is not a claim that managed database caches are empty.
2. **History:** page sizes 5 and 25; first/middle/last pages and equal timestamp ties. Follow real cursors, no offset/global-history reads. Check ownership, ordering, duplicates, omissions and response limits against offline archive references. Measure cursor acquisition separately from target page time.
3. **Earn:** existing admin counter-sale and supported synthetic sale-store operations, distinct members and concurrent updates to the same member. New operation IDs for new business actions; exact retries reuse IDs/payloads.
4. **Redemption:** sufficient points/stock, insufficient stock/points, distinct operation IDs for the same member, duplicate same-key, changed-payload replay, response-loss recovery and cancel/complete races. Isolate faults from ordinary latency samples, but keep their own timing report.
5. **Traffic:** representative 5 simultaneous operations; sustained cap 20 in-flight; synchronized bursts of 50 arriving within one second; same-reward and summary-shard groups of 20. Concurrency is not requests/second. For sustained shop-headroom testing propose 5 arrivals/second, bounded queue 100, with fixed seeded operation mix: 40% member/profile reads, 20% history pages, 15% earns, 15% redemptions, 5% profile updates, 5% admin summary reads. Registration remains a separate counter-contention probe rather than an accidental dominant workload. This is an explicit test assumption, not observed real shop traffic.
6. **Repetition:** three independently reset or equivalent-state measured runs per case, 2-minute warm-up then at least 10 minutes and >=1,000 observations per primary read/earn/redemption class. Use dedicated class runs to fill shortfalls. Repeat each synchronized burst/contention condition at least 50 times (>=1,000 operations at concurrency20). Report p50/p95/p99, sample count, first-pass resolution, deadlines, retry distribution and throughput per operation/case/run; no pooling that masks a failing run.
7. **Avoid measurement bias:** record scheduled and actual arrival, queue wait, in-flight count, client CPU/event-loop lag and memory. Bounded queues record overload instead of silently lowering arrival rate. No concurrent archive generation, import or cleanup during measured runs. A saturated runner invalidates server-capacity interpretation.

Use existing 84-test relevant regression set before new adapter use and after benchmark instrumentation/transport changes. Reuse the existing financial callbacks and integrity assertions, not a separate implementation. Save all metrics, workload seed, receipts/outcomes, resource samples, source hashes, region/index/concurrency settings and limitations.

## 5. Contention: measure baseline before changing sharding

Keep current 32 shards, hash routing, summary updates in the financial transaction and retry behavior for the baseline. Current emulator evidence establishes possible shared-document pressure, not production-service latency. Firestore notes that document contention depends on conflicting transactions and workload; locks and retries must be measured on the selected service. [Transaction contention](https://firebase.google.com/docs/firestore/transaction-data-contention).

Repeat the existing controlled matrix on full data:

- Distinct rewards + distinct summary shards (control).
- Distinct rewards + natural hash distribution.
- Distinct rewards + one shared summary shard.
- Shared reward + distinct summary shards.
- Shared reward + natural distribution; stock 5 with exactly 5 commits and 15 denials, plus sufficient-stock trials separating stock exhaustion from serialization.

Record begin/read/commit/rollback timing, ABORTED messages, per-operation attempts and first-pass/final outcomes. Admin summary fan-out reads and registration counter contention get separate diagnostic runs. Randomize repeat order to reduce warm-up/order bias.

Do **not** expand shard count before baseline: it would change the comparison and would not remove a hot reward's serialization. If managed-service baseline breaches targets, STOP and propose a separately reviewed A/B change. More shards affect summary fan-out, atomic summaries and migration compatibility; they are not a free configuration tweak. Do not weaken consistency, move updates out of the transaction or change retry priority during this benchmark.

## 6. Resource estimates and crash/cost protection

All estimates are planning allowances, not measured requirements or vendor guarantees.

| Option | Initial resource allocation | Scope / limits |
|---|---|---|
| Recommended managed Firestore test project, us-east4 | Runner e2-standard-4, 4 vCPU /16 GiB /50 GiB SSD; Node 22.23.2 | Streaming only; managed storage/index use measured during calibration. Provisional 30 GiB database/index allowance for all cases, reviewed from actual indexed storage before continuing. |
| Optional dedicated emulator VM | 8 vCPU /64 GiB /100 GiB SSD, Java heap 40 GiB | One full archive at a time; no personal workstation. This is a calibration candidate, NOT a known minimum or a substitute for managed-service performance evidence. |

The observed 1.50 GB private memory at 240k documents does not establish linear scaling. A naive ratio would already suggest tens of GiB at 5.83M, but fixed overhead, indexes and GC make it unsuitable for certifying a RAM minimum. Calibrate at 100k, 240k, 500k, 1M and subsequent bounded checkpoints, including idle-after-GC memory trends. Abort before a predicted breach; never expand heap automatically.

Managed runner: cap Node heap at 2 GiB, stop new work at RSS 4 GiB, system available RAM <2 GiB, disk free <10 GiB, or sustained client saturation. Emulator candidate: watchdog soft stop at process RSS/private 44 GiB, VM/container hard memory cap 48 GiB, host available RAM <12 GiB, or disk free <20 GiB; reserve at least 16 GiB outside the emulator hard cap. Avoid active swapping/heap dumps exhausting disk. Use an out-of-process watchdog sampled every 1–3 seconds, log rotation capped at 5 GiB, streamed checkpoints, bounded queues and documented drain/termination behavior. A guard stop means incomplete evidence, never PASS. Existing desktop limits remain untouched.

Import arithmetic: largest archive takes about **3.2–8.1 hours at 500–200 committed documents/s**, excluding ramp-up, retry, indexing and readback. All four contain 15.4M documents: **8.6–21.4 hours** at that rate. Allow **2–3 scheduled days** for imports, complete readback, index readiness and repeated benchmarks; slower calibration extends this estimate. Set a 12-hour per-case import review point and a 72-hour overall stop/review deadline, preserving checkpoints instead of restarting archives.

Cost gate: before approval price the selected region's read/write/delete/index/storage/runner charges and set a monetary ceiling B. Initial action budgets: <=20M attempted document writes, <=30M document reads plus separately counted billed index reads, <=72 runner-hours; stop/review before any allowance is exceeded. These are run guards, not pricing estimates or Firestore quotas. Include retries, verification, retained test storage and any later authorized cleanup. Budget alerts do not cap spending; an independent watchdog and runner operation counters must halt new work before the approved monetary/action ceiling, with reserve for in-flight work and delayed billing. [Cloud Billing budget limitations](https://cloud.google.com/billing/docs/how-to/budgets).

## 7. Actual benchmark round sequence

1. Approve targets, exact isolated environment/region, cost/resource ceilings and test-only transport/index preparation scope. No approvals are inferred from this planning milestone.
2. Prepare isolated credentials and target guards; review adapter parity; run relevant tests and a tiny synthetic safety/calibration case. No Production/live-staging credentials or data.
3. Validate existing archives against manifests, stream/import one complete case, verify counts/content, wait for indexes, enable only its synthetic writer.
4. Capture unchanged baseline, warm-up and measured matrix; collect resource/cost metrics and reconcile every financial outcome. Stop on integrity, isolation, resource or budget violation.
5. Repeat on remaining cases using the same archives and documented equivalent fixture preparation. If targets fail, retain the failure; do not silently tune architecture or retry settings.
6. Run relevant regressions, record PASS/BLOCKED by gate, stop runner and preserve artifacts. Report limitations: backend-only, tested region and synthetic activity. Cleanup only if explicitly authorized for the exact test resources.

## Updated regional preflight and approval gates

`V2_CAPACITY_COST_CONFIG_PREFLIGHT.md` closes the configuration blocker and records the selected `us-east4` public rates. With unchanged four-archive operation allowances, LOW / EXPECTED / SAFE MAX are **USD 31.62 /42.56 /62.59**, approximately **THB 1,107 /1,490 /2,191** at 35 THB/USD, including the 10% planning reserve. SAFE MAX is conditional on run limits, not a guaranteed invoice cap. Retain the proposed **USD 100 approval ceiling / USD 60 pre-tax operational stop**, counters, 72-hour VM limit and seven-day cleanup deadline. Exact component calculations are in `outputs/v2-capacity-cost-estimate.json` in the containing workspace.

Existing transport API/static compatibility with Node 22.23.2 is PASS; actual Node 22 execution and future remote-adapter compatibility are NOT YET VERIFIED. The local available runtimes are Node 24, and historical 84/84 must not be presented as a Node 22 result. Require exact-version syntax/import, mocked transport, target/cost guard and relevant emulator/parity tests as a preparation gate before full import. No transport/source change or runtime installation was made during this review.

**Next safe action:** owner approves the NEW `us-east4` project/database/billing scope, runner/IAM/index/test-only transport preparation with Node 22.23.2, USD 100 budget with guards, acceptance criteria and named cleanup owner. After preparation checks pass, obtain separate explicit authorization for full import and benchmark. No dataset loading, benchmark, provisioning, deploy, commit or push was performed in this milestone.
