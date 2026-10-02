# Firestore v2 — local synthetic implementation results

Date: 2026-09-22. Branch: `staging`. **PASS for this local server-layer milestone only.** No remote deployment, Production access, live staging fixture mutation, actual-data migration, credential change, commit or push. Existing tracked v1 source and entrypoints have no diff.

## Implemented boundary

`netlify/functions/lib/v2/firestore.mjs` implements Firestore REST beginTransaction/batchGet/runQuery/commit/rollback. Financial transactions allow at most 20 distinct documents and 512 KiB logical read-plus-write bytes. All writes require a transactional read of the target and a create/existence precondition. Callbacks cannot run historical queries in write transactions. Retries occur on Firestore ABORTED, with backoff and a 12-attempt limit. An ambiguous transport failure is not interpreted as rollback; callers retain the same operation key.

`member-store.mjs` resolves only the necessary identity, bill, customer, reward, receipt and session documents, then reuses the existing v1 pure financial functions on this bounded projection. It does **not** use v1 RTDB transport. The resulting changes, summary shard, ledger and receipt are committed together. Existing operation scopes/fingerprints/results are retained; no receipt TTL is configured. Existing statuses/calculations are reused for earn, sale recalculation/reversal, redemption, cancellation/completion and admin reward operations. Registration/profile uses transactional LINE/phone indexes and member-code counter; customers cannot supply points or roles.

`handlers.mjs` provides local handler factories with existing endpoint names/request fields for member-profile, member-state, reward-redemption, admin-operations, admin-session and sale operations. Admin cookie/origin/password validation is retained; session is rechecked inside mutations. LINE verification uses the existing verifier. Tests substitute only its external HTTP responses, not the financial database.

The factory is deliberately **not routed into existing Netlify entrypoints**. Current LINE/LIFF UI and RTDB v1 remain unchanged. This milestone implements/tests the server datastore and API layer, not a live UI rollout. Global admin list pages, audit/expiry/notification writers and frontend pagination consumption are not enabled on v2. Admin global member-state requests explicitly fail closed; authoritative admin summaries are available through the server store method. No v2 endpoint silently falls back to v1. No notification is sent by the local sale handler.

## Local schema

All data is under `v2/synthetic-<run-id>/<collection>/<id>` in emulator project `demo-member-v2`. Existing record IDs are retained by the synthetic importer.

- Mutable documents: customers, rewards, pendingPurchases, adminSessions, loginAttempts.
- Retained individual records: transactions, redemptions and secureOperations. These collections are never embedded in a financial document or root transaction.
- Direct lookups: lineMembers, phoneMembers, bills, counters/memberCode, legacyOperationBlocks.
- Summaries: 32 summaryShards updated atomically alongside financial deltas; per-customer pendingRedemptionCount updated with redemption transitions.
- Control: control/writer requires schemaVersion=2, epoch=synthetic-v2 and writesEnabled=true.

The transport accepts only `127.0.0.1:8085`, project `demo-member-v2`, context dev/test, explicit FIRESTORE_V2_MODE=emulator and a synthetic namespace. It has no remote service-account/OAuth path. Emulator-only `Bearer owner` is used server-side. Direct clients are denied by `firebase/firestore.local.rules`.

## Integration results

25 distinct Firestore integration cases PASS, executed as a 23-case suite plus two focused additional cases after adding history detail and explicit completion coverage. Evidence: `outputs/v2-integration.txt`, `v2-pagination-detail.txt`, `v2-final-transitions.txt` in the containing workspace. No skipped tests in those runs.

Coverage includes environment guard; client Rules denial; forged/missing admin session and invalid LINE; authorized login/earn/logout; registration/profile whitelist and concurrent uniqueness; atomic redemption; concurrent duplicate keys; mismatched payload; price-change replay; lost successful response; precommit failure; insufficient points/stock; inactive reward; ownership; cancellation using stored snapshots; cancel/complete race; unlimited stock; uncertain reservation refusal; sale earn/recalculate/reverse; transaction-time session revocation and concurrent logout; member-scoped pagination; preserved migration receipts; document/aggregate budget rejection; same-member distinct-key overspend; concurrent profile/earn/spend; pending approval/reject race; reward catalog/archive; stable-date redemption cursors and owned history detail; successful completion without second debit.

55 relevant v1 regression cases PASS (`transport`, `reward-redemption`, `security`, `shared-writers`). This reruns no RTDB emulator or legacy reconciliation workload. Total: **80 distinct test cases PASS**, plus the five workload/scope scenarios below. Syntax checks on seven new MJS files and JSON parsing PASS. Secret-pattern scan of new code/test files found no secret-shaped values; deliberately synthetic test passwords and emulator owner marker are not real credentials.

## Workload measurements

5/20/50 mixed workloads: 5,000 synthetic members, 20 rewards, 1,650 retained zero-point history entries. Mixture: member state, catalog/member state, registration, admin counter-sale earn, redemption, admin summary. This resembles the v1 workload roles but is not identical: admin summary replaces global arrays, counter-sale replaces service earn, and the historical rows are a smaller fixture representation. Do not treat latency differences as a controlled benchmark or Production SLA.

| Scenario | Initial success / eventual result | Local p50 / p95, ms | ABORTED conflicts / callback retries | Financial max docs read / written | Financial max logical / commit JSON bytes |
|---|---|---:|---:|---:|---:|
| Representative 5 | 5/5, no external retry | 172 / 236 | 0 / 0 | 8 / 6 | 2,203 / 4,003 |
| Concurrent 20 | 20/20, no external retry | 740 / 4,605 | 6 / 6 | 8 / 6 | 2,212 / 4,010 |
| Burst 50 | 48/50 initially; two retry-same-key 503s recovered, 50/50 eventually | 1,488 / 27,646 | 108 / 106 | 8 / 6 | 2,212 / 4,010 |
| Same reward: 20 contenders, stock 5 | 5 commits, 15 insufficient-stock denials, no unresolved requests | 22,301 / 22,525 | 155 / 155 | 8 / 6 | 2,196 / 4,000 |

The last conflict of an exhausted attempt is not followed by an internal retry; thus conflict and retry counts can differ. Burst recovery uses the original key and is reported separately. Metrics are initial request batches, not recovery or verification reads. Timings include local REST/Java scheduling and are observational.

Same-reward verification found stock=0, stockVersion=5, exactly five debits/redemptions/receipts, only winning members debited and totalPoints=19,900. Mixed loads verified affected balances, reward/version, authoritative totals/counts and exact receipt replay without subsequent balance changes. No negative stock, lost point updates or duplicate debit observed. Full metrics: workspace `outputs/v2-workload.json` and `v2-workload.txt`.

Across successful integration financial operations, maximum scope was **9 documents read / 6 written**, maximum logical read-plus-write **2,815 bytes**, maximum serialized commit **4,114 bytes**. Sale confirm required nine reads; redemption normally eight. Cancel was the largest sample. Budgets are tested rejection boundaries, not claims that every possible real record fits. Per-label measurements: `outputs/v2-financial-metrics.json` (23-case suite plus explicit completion/rejection case; pagination-detail case excluded from this aggregate).

Logical bytes exclude Firestore wire field wrappers/index storage. Commit JSON bytes include wire document names/fields; total HTTP request/response bytes, including retries, are also in workload JSON. Platform index amplification/billing are not measured by these local JSON counters.

## Retention-scope result

| Historical transaction count | Retention horizon | Financial docs read / written | Logical bytes | Commit JSON bytes | Local observed operation ms |
|---:|---:|---:|---:|---:|---:|
| 0 | none | 8 / 6 | 2,197 | 4,000 | 141 |
| 32,850 | 1,095 days | 8 / 6 | 2,197 | 4,000 | 141 |

The same member/reward request accessed exactly the same bounded participant count and logical bytes as history grew. Member-state returned at most the requested five history rows and the correct 980-point balance. This establishes bounded transaction scope with a representative three-year history, **not** a full-envelope storage/throughput certification. The 602,250 normal-volume transactions plus 54,750 redemptions and 602,250 receipts were not all loaded into this 1.5 GiB Java emulator.

The previous v1 evidence required transferring/rewriting the complete 3,074,699-byte root; planned normal three-year root was 534,853,599–536,468,600 bytes against its 8,000,000-byte guard. v2 does not read that aggregate. v1 burst50 had 46 initial successes, four safe recoveries, 161 conflicts and p95 30,455 ms; v2 observed 48 initial successes, two recoveries, 108 conflicts and p95 27,646 ms. However v2 same-reward contention still has significant latency and 155 aborts, versus 78 CAS conflicts in the older v1 experiment. Smaller payload has not eliminated contention on shared stock or summary shards.

## Migration fixture and read behavior

`scripts/v2-synthetic-fixture.mjs` accepts an explicitly synthetic envelope, builds indexes/summaries and imports with create-only batches into a synthetic emulator namespace. It has no RTDB reader, remote export input or destructive write. Partial failed imports are not active because control/writer is imported last; this is an isolated fixture importer, not resumable real-data migration tooling. Do not reuse a partially loaded namespace; start a separate synthetic namespace. Duplicate IDs, dangling references and missing history dates fail preparation. No dates or transaction outcomes are inferred.

Tests seeded v1-generated redemption/debit/receipt objects, preserved customer/reward/transaction/redemption IDs and operation fingerprints, and replayed the old operation through v2 without another debit. Exact receipt objects survived. Reimport into an occupied namespace failed without overwriting it. This does not certify real legacy records or normalize any actual data.

Member-state uses a read-only Firestore transaction, direct member lookup and customerId-filtered queries with a maximum page size of 25. Cursors bind owner and collection and use date plus document ID to disambiguate ties. Rewards are paged independently of history. Points/pending counts come from authoritative mutable state, next expiry from a dedicated indexed query. Full transaction/redemption detail is an owned direct read. Multi-page views can span fresh snapshots; the API does not promise an indefinitely frozen history across requests.

`member-state?limit=5&transactionsCursor=...` exposes the next history page; equivalent redemptionsCursor/pendingPurchasesCursor/rewardsCursor parameters exist. `member-state?detail=transactions&id=...` and `detail=redemptions` fetch owned detail. `state`, `pages`, `summaries` are separate response fields. The unchanged live frontend has not yet been connected to this v2 factory and must consume pagination metadata before any future rollout.

## Reproduce locally, without deployment

Use the already downloaded/checksummed Firestore Emulator 1.22.0 JAR (SHA-256 `9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c`) and portable Java 21.0.12.1. Binaries remain outside the repository under the containing workspace's `work/emulator-runtime`.

From the repository in PowerShell, using the portable Java executable:

```powershell
$socketDirectory = (Resolve-Path '../emulator-runtime/tmp').Path
& '../emulator-runtime/java/jdk-21.0.12.1+1-jre/bin/java.exe' "-Djdk.net.unixdomain.tmpdir=$socketDirectory" -Xmx1536m -jar '../emulator-runtime/firestore.jar' --host 127.0.0.1 --port 8085 --project_id demo-member-v2 --single_project_mode true --single_project_mode_error true --rules firebase/firestore.local.rules
```

The temporary-directory property is process-local. Java's default Unix-domain socket connection failed in this Windows environment; the workspace runtime directory lets its pipe implementation fall back to loopback TCP. No system setting or Java installation was changed. See [OpenJDK Windows pipe implementation](https://raw.githubusercontent.com/openjdk/jdk21u/master/src/java.base/windows/classes/sun/nio/ch/PipeImpl.java).

In another local terminal with Node available (or invoke its portable absolute executable path):

```powershell
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'
$env:FIRESTORE_V2_TESTS = 'true'
node --test tests/v2-integration.test.mjs
node scripts/test-v2-workload.mjs
```

Use only the demo project; tests create new isolated synthetic namespaces. Rules/index files are local/proposed only. The Firestore native emulator does not establish deployed composite-index readiness; the supplied index definitions need validation in a later explicitly authorized isolated staging milestone. No Firebase CLI deploy command is part of this procedure.

## Remaining boundaries

- This PASS concerns bounded server-layer correctness on the actual local emulator. It is not Production readiness or approval to enable Firestore remotely.
- Full planning-envelope storage/index/cost and deployed latency remain unmeasured. Same-resource tail latency and retry exhaustion must be addressed against an agreed SLO before release; no atomicity was weakened to improve success counts.
- HTTP timeout is 12 seconds per call, with a 12-attempt cap and elapsed-time check after aborts. This is not yet a hard overall Netlify deadline. Runtime deadline/cancellation policy needs deployment-specific review before remote enablement.
- Frontend v2 pagination consumption, global admin lists, remaining shared writers and remote IAM/index validation are not routed/enabled here. No dual-authoritative operation or cross-store rollback exists.
- Real-data migration/certification, external stock contract and Production cutover remain outside this milestone. v1 has been preserved, not declared safe as a rollback target after future v2 writes.

Next safe action: review this local implementation and evidence. Stop here; obtain a separate instruction before any next milestone or remote configuration.
