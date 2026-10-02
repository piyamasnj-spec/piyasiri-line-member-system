# V2 isolated capacity — cost/config preflight

Reviewed 2026-10-01. **STATUS: PREFLIGHT READY — region/runtime configuration review CLOSED; execution remains NOT AUTHORIZED.** Owner confirmation supersedes the earlier Singapore assumption. No cloud project/resource creation, data import, benchmark, deploy, credential change or Production/live-staging access. Existing archives were not regenerated. This supplements `V2_ISOLATED_CAPACITY_TEST_PLAN.md` and does not authorize its execution.

## Configuration evidence and recommended region

| Evidence in current workspace | Confirmed | Cannot establish |
|---|---|---|
| `netlify.toml:1` build command; `:8` functions directory | Static build via Node script; Node functions in `netlify/functions`; one scheduled function | Actual deployed Functions region or Node version |
| No `package.json`, `.nvmrc`, `.node-version`, `NODE_VERSION`, `AWS_LAMBDA_JS_RUNTIME` or function region override found in current app configuration | No repository runtime/region pin | Netlify UI environment overrides and active deploy metadata |
| `netlify/functions/lib/firebase-rest.mjs:6` | RTDB endpoint comes from server environment `FIREBASE_DATABASE_URL` | RTDB location; no credential/environment values were read |
| `netlify/functions/lib/v2/firestore.mjs:5` | V2 is emulator-only: loopback `127.0.0.1:8085`, project `demo-member-v2` | Any existing deployed V2 Firestore region |
| Local portable Node `--version` | v24.19.0 | Netlify deployed runtime |

The owner has now confirmed the active Production deployment directly from Netlify: **Functions region IAD (N. Virginia, US East); Node runtime/build v22.23.2; active deploy `main@eae491d`; 6 functions deployed.** These are owner-supplied configuration facts, not an agent inspection of Production. They resolve the repository's missing region/runtime metadata. Six deployed functions does not establish that local V2 is deployed; this review does not infer function identities or compare/switch to main.

**Recommended test region: Firestore `us-east4` (Northern Virginia), with the GCE runner in `us-east4`.** This matches IAD's geographic locality without changing existing hosting. `iad`, AWS region identifiers and GCP `us-east4` are different provider identifiers, not interchangeable configuration strings. Use regional Standard/Native Firestore, not an assumed multi-region database.

No further Production configuration evidence is required for this review. Pin the isolated runner to **Node v22.23.2**. A same-region GCE benchmark is database/backend evidence, not a certification of Netlify cold starts, AWS-to-GCP latency or real LINE E2E. Geographic alignment does not make a GCE runner the same runtime/platform as Netlify.

## Verified public rates — Northern Virginia selection

Selected **Northern Virginia (us-east4)** in the actual public Firestore, E2 and disk pricing dropdowns; did not copy Singapore or default Iowa rates. Default/on-demand consumption, no CUD/Spot/free-tier/credit deductions. Rates can change before execution. All scenario quantities and cost guards remain as before; only regional prices changed.

| Item | USD rate |
|---|---:|
| Firestore Standard document writes | 0.099 /100,000 |
| Document reads and billable index-read units | 0.033 /100,000 |
| Document deletes | 0.011 /100,000 |
| Document + index storage | 0.099 /GiB-month; hourly display 0.000135616 |
| E2 standard-4, Linux, 4 vCPU /16 GiB | 0.15094164 /hour |
| Zonal SSD persistent disk | 0.000256164 /GiB-hour |

Sources: [Firestore pricing](https://cloud.google.com/firestore/pricing), [Compute E2 pricing](https://cloud.google.com/products/compute/pricing/general-purpose#e2-machine-types), [Disk pricing](https://cloud.google.com/compute/disks-image-pricing). The chosen concrete runner has 16 GiB, above the earlier minimum allocation of 8 GiB; no custom-machine premium or Windows licence is assumed.

Firestore index maintenance is not counted as another document-write line item. Index storage and billable index reads are estimated separately. A billable standard index-read unit is generally a per-query batch of up to 1,000 scanned entries where the query is chargeable; it is NOT one returned document or one scanned entry. Current queries order by a field and `__name__`, so do not assume every page is exempt. Calibrate with Query Explain before volume traffic. Same-region GCE-to-Firestore data transfer has no Firestore transfer charge; external results transfer/logging gets an allowance below. [Pricing mechanics](https://cloud.google.com/firestore/pricing#index-reads).

FX: use **35 THB/USD** as a conservative planning conversion, not an invoice exchange rate. EXIM's public October 1, 2026 table quotes USD selling 33.77 THB. Actual billing currency SKUs, payment conversion and tax depend on the account. The additional 10% reserve below is a planning allowance, NOT a statement that tax is 10%. [EXIM rate](https://www.exim.go.th/EN/exchange_rate/exchange.aspx).

## Scenario assumptions — all four archives reused

Baseline import is **15,405,216 documents** across four distinct namespaces, each imported once. All scenarios cover all four archives; LOW does not mean testing only the largest or skipping verification. Extra allowances cover uncertain import responses, retries, benchmark operations, fixtures and cleanup. Existing archives remain immutable. Missing or excessive costs stop the run rather than shrinking evidence without disclosure.

| Quantity | LOW | EXPECTED | SAFE MAX |
|---|---:|---:|---:|
| Import write attempts | 15,405,216 | 15,600,000 | 16,000,000 |
| Document readback/verification reads | 15,405,216 | 16,000,000 | 16,000,000 |
| Benchmark document writes | 500,000 | 1,500,000 | 4,000,000 |
| Benchmark document reads, including retry reads | 2,000,000 | 6,000,000 | 14,000,000 |
| Billable index-read units (not entries) | 500,000 | 2,000,000 | 10,000,000 |
| Runner hours | 24 | 48 | 72 |
| Disk/database retention hours | 48 | 96 | 168 |
| Document storage allowance, GiB | 8 | 10 | 10 |
| Additional index storage allowance, GiB | 7 | 20 | 20 |
| Cleanup delete allowance | 16,000,000 | 18,000,000 | 20,000,000 |

Storage is conservatively charged at the stated full-case allocation for the entire retention interval rather than estimating a smaller growing average. These GiB values are provisional allowances, not measured indexed Firestore sizes: 6.05 GB JSONL across all cases is not native storage usage. Stop before import exceeds a 30 GiB projected combined footprint; if calibration forecasts more, revise the estimate before proceeding. Do not silently add storage or regenerate datasets. SAFE MAX is a bounded scenario, not a universal maximum bill.

## Cost breakdown

USD before the final 10% reserve; rounding each displayed row can differ slightly from the exact total. Formulas: operations/100,000 × regional unit rate; storage GiB × retained hours × hourly rate; compute hours × VM rate; 50 GiB × disk hours × disk rate.

| Cost component | LOW USD | EXPECTED USD | SAFE MAX USD |
|---|---:|---:|---:|
| Import document writes | 15.25 | 15.44 | 15.84 |
| Document readback/verification | 5.08 | 5.28 | 5.28 |
| Benchmark writes | 0.49 | 1.49 | 3.96 |
| Benchmark document reads | 0.66 | 1.98 | 4.62 |
| Billable index reads | 0.17 | 0.66 | 3.30 |
| Document storage | 0.05 | 0.13 | 0.23 |
| Index storage | 0.05 | 0.26 | 0.46 |
| Runner compute | 3.62 | 7.25 | 10.87 |
| 50 GiB SSD including retention | 0.61 | 1.23 | 2.15 |
| Cleanup document deletes | 1.76 | 1.98 | 2.20 |
| External transfer/logging allowance | 1.00 | 3.00 | 8.00 |
| **Subtotal** | **28.75** | **38.69** | **56.90** |
| **Including 10% planning reserve** | **31.62** | **42.56** | **62.59** |
| **THB at 35/USD** | **1,107** | **1,490** | **2,191** |

No paid snapshots, PITR, TTL jobs, backups, restores, GCS archive bucket, load balancer, public/static IPv4, NAT gateway, Cloud Workstations, Netlify deployment or LINE calls are included. The intended runner uses a private subnet with Private Google Access and IAP administration; packages/artifacts must be pre-staged through the approved access path. Adding Internet/NAT/package services requires repricing. Retain bounded local logs and export only necessary result artifacts, not full database responses; the transfer/log allowance is a budget assumption, not a quoted network SKU. No monthly subscription/commitment is required by this proposal.

Exact arithmetic/inputs: workspace `outputs/v2-capacity-cost-estimate.json`. These figures estimate spending, not that all benchmarks will finish before a cap. If workload retries or verification exceed the limits, report incomplete evidence and stop.

## Proposed cost guards — not yet installed

Propose owner approval ceiling **USD 100 / THB 3,500**, with a **USD 60 pre-tax operational stop** and reserve for cleanup, storage tail, in-flight work, FX/tax differences and delayed billing. No approval is assumed. A provider-enforced absolute total-bill cap is NOT established here.

1. Persist atomic pre-dispatch counters outside the worker; reserve worst-case charge before sending a batch/query and after each transaction retry. Attempt ceilings: 20M total document writes, 30M total document reads, 10M index-read billing units, 20M cleanup deletes. Count read-only verification, query minimums, errors/uncertain outcomes and retries conservatively. Fail closed if counters/price configuration cannot be read or checkpointed. Reconcile reservation excess only with reliable evidence; do not assume a timeout is free.
2. Pagination bounds returned documents, not necessarily scanned indexes. Before a query shape is calibrated, reserve a conservative upper bound derived from the complete target collection size and query count, not only page size. Query Explain samples and index readiness are a pre-load gate. If a safe per-request cost bound cannot be established, block that workload. Operation counts are charged document units, not HTTP requests.
3. Stop dispatch at whichever comes first: counters, USD 60 model, 72 VM hours, 30 GiB projected storage, or the existing memory/disk guards. Pre-reserve pending batches, remaining storage retention and shutdown/cleanup costs. No automatic retries after a global stop; reconcile already in-flight mutations by the same operation IDs.
4. Single explicitly named test project/database and one VM; no autoscaling, auto-restart or worker fan-out. Infrastructure-level VM maximum runtime of 72 hours plus an independent local process watchdog. Storage/artifact cleanup deadline 7 days, with a named owner. VM stop alone does not remove persistent charges. The worker receives no project/resource-creation permission.
5. Project-scoped billing alerts at USD 25/50/75/100 are an independent warning layer; they are not the hard stop. Google states alerts-only budgets do not prevent further charges. The currently documented spend-cap preview lists particular eligible services, not Firestore or Compute Engine, and does not stop persistent compute/storage charges. Do not represent it as covering this plan. [Budget alerts](https://cloud.google.com/billing/docs/how-to/budgets), [Spend-cap scope](https://cloud.google.com/billing/docs/how-to/budgets-spend-caps).
6. Benchmark cannot start until guard fault-injection verifies fail-closed behavior and a cleanup/shutdown owner is agreed. If an absolute provider-guaranteed USD ceiling is mandatory, remain BLOCKED rather than claim these application controls guarantee it under every failure.

## Exact resources/config to prepare later

- One new dedicated test project linked to an approved billing account; one Firestore Standard/Native database with selected immutable region, recorded concurrency mode and four synthetic namespaces. No RTDB, Firebase Auth, Hosting or LINE project. Disable TTL, PITR and backup schedules for this disposable run. Deny direct client access; server IAM identity alone runs the harness.
- One on-demand Linux `e2-standard-4` VM in the chosen region with one 50 GiB zonal SSD; private VPC/subnet, Private Google Access, IAP/OS Login administration and restricted firewall. No public IP/NAT/LB. Enable only needed Firestore, Compute, IAM/IAP and budget/monitoring APIs; no paid managed logging pipeline is required.
- Separate provisioning/admin identity and least-privilege test data runner identity. Runner uses attached short-lived credentials, no downloaded service-account JSON. Test project/database allowlist enforced before every call; no access to existing projects. Cleanup permission is separately scoped to recorded resource IDs.
- Existing 5 proposed COLLECTION-scope composite indexes: `transactions(customerId ASC,date DESC)`; `redemptions(customerId ASC,date DESC)`; `pendingPurchases(customerId ASC,date DESC)`; `transactions(customerId ASC,type ASC,expiresAt ASC)`; `rewards(visible ASC,id DESC)`. Preserve field exemptions for `secureOperations.result`, `transactions.pointBreakdown`, `.alerts`, `.proof` from `firebase/firestore.local.indexes.json`. Confirm actual query ordering including `__name__` and wait for all indexes READY. Do not change index strategy just to reduce the estimate without a new baseline plan.
- A reviewed test-only REST transport adapter with exact project/database binding, real IAM token handling, synthetic auth fixtures, instrumentation and import-resume checkpoints. Current V2 transport only accepts loopback and emulator `Bearer owner`; it cannot be used remotely as-is. Preserve financial logic, 32 shards, existing retry behavior and all budgets. Pin runner Node to **v22.23.2**; run parity tests before importing. No application architecture change is authorized here.
- Cost counters/watchdog, project-scoped budget alerts, VM runtime stop and cleanup manifest. Proposed config names can be `CAPACITY_TEST_PROJECT_ID`, `CAPACITY_TEST_DATABASE_ID`, `CAPACITY_TEST_REGION`, `CAPACITY_TEST_NAMESPACE`, `CAPACITY_COST_STOP_USD`, `CAPACITY_EXPIRES_AT`; these are new test-only proposal names, not existing production environment variables.
- Existing 4 archive/manifest pairs transferred once to runner SSD and verified there. No regeneration, cloud data copy or Production read.

## Cleanup plan and forgotten-resource costs

Plan and approve the exact cleanup scope BEFORE the benchmark. Nothing is deleted this round.

1. Disable synthetic writer access, stop job dispatch, drain/check uncertain receipts and save local reports/checkpoints/receipts needed for review; keep immutable source archives on the existing workstation.
2. Stop the VM at benchmark end even if review/cleanup is pending. Export only bounded result artifacts via the approved route.
3. Using the exact allowlisted run manifest, delete synthetic documents/subcollections or the dedicated database through an explicitly approved database cleanup. The estimate reserves document-delete charges conservatively; do not rely on a particular bulk/database-delete method being free. Never delete just a parent document and assume subcollections disappeared.
4. Delete the test VM and its disk; inspect for unattached disks, snapshots, backups, reserved addresses, buckets, logging exports or NAT resources that might have been added. Remove only this test's IAM grants/identities and temporary access. No existing credentials are rotated.
5. Verify resource inventory is empty, then close/delete the isolated project if explicitly approved. Keep billing visibility and review delayed charges after cleanup. Deleting budget alerts or unlinking billing alone is not the cleanup mechanism.

If forgotten: the VM alone is about USD 110.19 per 730-hour month; 50 GiB SSD about USD 9.35/month; 30 GiB Firestore document/index storage about USD 2.97/month. Together approximately **USD 122.51 / THB 4,288 per month before reserve**, excluding activity/other resources. After VM stop, disk and database alone still cost roughly USD 12.32/month. Backups, snapshots, IPs, NAT and exported logs can add charges if introduced. Daily/hourly proration and account prices govern the actual invoice.

## Node 22 compatibility review

**Static/API review PASS for existing V2 transport; runtime execution on Node 22 NOT RUN in this review.** The workspace runtimes found are v24.19.0 and v24.14.0. Neither is evidence of a Node 22 test. No runtime was installed and no emulator/benchmark was started. Historical 84/84 remains historical and is not relabeled a Node 22 result.

Reviewed `netlify/functions/lib/v2/firestore.mjs` and the API surface of its helper/store/handler imports. The transport uses `.mjs` ESM, `node:timers/promises`, global `fetch`, `AbortSignal.timeout`, `performance.now`, `structuredClone`, Buffer/JSON/Map/Set and standard async JavaScript. These APIs exist in Node v22.23.2; no Node-24-only API or native package dependency was found in this transport. [Node 22 globals](https://nodejs.org/download/release/v22.23.2/docs/api/globals.html), [Timers](https://nodejs.org/download/release/v22.23.2/docs/api/timers.html), [ES modules](https://nodejs.org/download/release/v22.23.2/docs/api/esm.html).

The cloud test-only adapter is still unimplemented, so it cannot yet receive a runtime compatibility PASS. Require Node 22.23.2 syntax/import and mocked transport tests covering serialization, abort/timeout, HTTP errors, ABORTED retry, response-loss receipt recovery and target rejection. Then run the relevant emulator/parity suite on that exact version before authorizing a full import. If adding an IAM library, pin a release supporting Node 22 and test token refresh on the isolated target; do not inherit an unreviewed Node 24 dependency. All such preparation is a later approval scope, not a change made now.

## Next safe action

Configuration review is closed. Before execution the owner must approve: (1) a NEW exact synthetic-only project/database in `us-east4`, its billing account and USD 100 ceiling / USD 60 operational stop; (2) one runner and test-scoped IAM/network/index/transport preparation pinned to Node 22.23.2; (3) the existing acceptance criteria and a named shutdown/cleanup owner with the seven-day retention limit. Preparation must produce passing target/cost guards and Node 22 parity evidence. Full import and benchmark require a subsequent explicit go-ahead after those checks. No provisioning, deploy, import or benchmark is authorized by the configuration confirmation alone.
