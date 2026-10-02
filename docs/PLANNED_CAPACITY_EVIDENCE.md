# Planned capacity evidence — BLOCKED

Owner-approved planning envelope, not observed Production statistics. Run 2026-09-21; branch staging. No Production or live staging access, no application changes, no push/deploy.

## Model and reproducibility

`node scripts/planned-capacity.mjs` streams synthetic schema-shaped records to measure exact compact UTF-8 JSON byte counts without allocating a multi-GB root. `scripts/test-planned-capacity.mjs` uses the existing REST/CAS implementation and pure server operations against 127.0.0.1:9000, namespace demo-member-stabilize only. It refuses other fetch destinations. Start the existing portable emulator and explicitly set FIREBASE_DATABASE_EMULATOR_HOST=127.0.0.1:9000 to run it. It overwrites that synthetic emulator namespace, never remote Firebase.

Assumptions: 1095 days; 5000/10000 initial members; 500/1500 earn transactions per day plus 50/200 redemption debits per day. Treating loyalty volume as earn volume is conservative and avoids silently excluding redemption debit rows. 20 synthetic catalog rewards; each financial operation retains one receipt with fingerprint/result. Pending purchases, security, operationLocks and notificationJobs are empty baselines. Additional profile/admin receipts, cancellations, notification jobs, completed-redemption metadata, images and longer text only increase size. UUID-shaped IDs, LINE-shaped synthetic identities and real field names are used. Dates and starting balances are representative sizing placeholders, not historical balance certification. This is a conservative lower-bound record mix, not a claim of exact future data distribution.

## Three-year sizing, fixed population

| Members | Load | Compact root bytes | First day above 8 MB | Last safe full history days / bytes |
|---:|---|---:|---:|---|
| 5000 | normal | 534853599 | 14 | 13 / 7935449 |
| 5000 | stress | 1678374989 | 5 | 4 / 7727689 |
| 10000 | normal | 536468600 | 10 | 9 / 7606150 |
| 10000 | stress | 1679989990 | 4 | 3 / 7814890 |

These thresholds count accumulation from an initially empty history with the stated population already present. They are optimistic practical bounds, not permission to operate until that day. Existing history, other collections and growth reduce headroom.

| Collection | Normal count / bytes (5000 members) | Stress count / bytes (5000 members) | Mean / largest record bytes, normal; stress |
|---|---|---|---|
| customers | 5000 / 1613891 | 5000 / 1613891 | 283 / 283; 283 / 283 |
| rewards | 20 / 3551 | 20 / 3551 | 160 / 161; 160 / 161 |
| transactions | 602250 / 270764511 | 1861500 / 832183891 | 403 / 414; 400 / 415 |
| redemptions | 54750 / 34985241 | 219000 / 139941001 | 592 / 593; 592 / 593 |
| secureOperations | 602250 / 227486251 | 1861500 / 704632501 | 310 / 337; 311 / 337 |
| pendingPurchases, security, operationLocks, notificationJobs | each 0 / 2 | each 0 / 2 | empty |

Collection bytes include object keys/separators; record byte statistics exclude collection keys. Root includes collection names/separators. At 10000 members customer bytes are 3228892; other collection sizes are unchanged under fixed daily throughput.

If new members continue at the planning rates for all three years: 5000 + 30/day => 37850 members / 545519850 bytes; 5000 + 100/day => 114500 / 1713981491 bytes. Starting at 10000 => 42850 / 547144850 bytes or 119500 / 1715616491 bytes. The 10000-member headroom from 5000 is consumed in about 167 normal-growth days or 50 stress-growth days. These are uncapped growth scenarios, not a prediction.

## Emulator workload results

Realistic smaller workload root: 3074699 bytes; 5000 members, 20 rewards, 1650 transaction rows, 150 redemption rows, 1650 receipts (3 normal-volume days). Mix by index modulo 6: member read, catalog/member read, registration, earn, redemption, admin read. Customer profile endpoint is used for registration. Existing-member profile edits and authentication/deployed Netlify behavior were not newly exercised. Admin/member selection uses application selectors, with explicit test actors; external identity services are not called.

| Workload | Initial success | Safe retry | CAS conflicts | p50 / p95 initial latency ms | Total including verification/replays ms |
|---|---:|---:|---:|---|---:|
| 5 normal concurrent requests | 5/5 | 0 | 3 | 1371 / 2312 | 3153 |
| 20 concurrent mixed requests | 20/20 | 0 | 25 | 1802 / 6481 | 8900 |
| 50 requests launched together | 46/50 | 4/4 | 161 | 3854 / 30455 | 36937 |

All four initial failures were handled 503 transaction_busy_retry_same_key after the existing 12-attempt bound. Retrying the same logical requests sequentially succeeded. This is safe resolution, not zero-error first-pass availability. No Production SLA is inferred. The 10-second transport timeout is per HTTP request, not the whole multi-attempt transaction; observed 30-second tail latency requires consideration in a future deployment/runtime decision.

Same reward: 20 simultaneous redemption attempts, initial stock 5; 5 successes, 15 handled insufficient-stock denials, 78 CAS conflicts; stock 0, stockVersion 5; only winners lost 20 points each. Exactly 5 debit rows, 5 redemptions and 5 receipts were added. This is isolated emulator data, not the existing staging fixture.

Assertions: balances by actor, stock, transaction/redemption/receipt count deltas, registration uniqueness; repeat all successful financial operations and compare customers/rewards/transactions/redemptions/receipts unchanged. No lost updates or duplicate debit observed; losing attempts produced no financial records. Realistic first-over-limit root rejects reads/transactions before any PUT. Previous proposed-write guard regression remains passing. No unhandled application errors; all expected conflicts/denials recorded.

## Tests and conclusion

New workload runner PASS: 3 mixed batches, same-reward contention, realistic oversize guard and exact generator-size vs serialized-root assertion. Relevant existing transport/redemption regression: 31/31 PASS. Emulator stopped after testing. No full 3-year root was uploaded: it already exceeds the application guard by roughly 67–210 times. Historical padded-root results are retained, not mistaken for topology or full-envelope evidence.

BLOCKED by architecture, not missing Production statistics. Every financial write reads/clones/serializes and conditionally rewrites the entire root; member-state also reads the root through the same 8 MB guard. Retained history and receipts therefore eventually block both financial operations and customer state loading. Global contention retries also incur repeated full-root transfer and processing.

Next decision: approve an architecture design review to bound transaction scope while preserving atomic points/stock/ledger/idempotency guarantees, and separate retained history from mandatory root reads. Include explicit receipt replay lifetime and history access requirements. Merely increasing the guard or deleting required history is not a solution. No schema restructuring, migration, retention change or guard increase has been implemented. No additional Production access is required to establish this blocker.
