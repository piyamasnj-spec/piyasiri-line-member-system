# V2 isolated staging adapter — local implementation contract

2026-10-02. LOCAL ONLY. No deployment, remote request, fixture mutation, resource, migration or paid action is authorized. Source is ready for review, not approved for remote validation. The old emulator transport remains the default; V1 entrypoints, frontend, Netlify configuration and RTDB implementation are unchanged.

## Target and identity contract

Remote startup and every Firestore call require explicit configuration. There is no ADC discovery, metadata-server fallback, default cloud project, configurable Firestore/OAuth hostname, or emulator-owner token on the remote transport.

| Environment name | Required contract (no secret values) |
| --- | --- |
| `FIRESTORE_V2_MODE` | Exactly `staging-test` |
| `V2_STAGING_TEST_ENABLED` | Exactly `true` |
| `CONTEXT`, `BRANCH` | Exactly `branch-deploy`, `staging` |
| `FIRESTORE_EMULATOR_HOST` | Absent/empty for remote; existing exact emulator configuration remains unchanged |
| `FIRESTORE_V2_PROJECT` | One explicitly approved isolated test project, not the live Staging project |
| `FIRESTORE_V2_DATABASE` | One exact database ID, including `(default)` only if explicitly allowed |
| `FIRESTORE_V2_NAMESPACE` | `synthetic-` plus 1–100 alphanumeric/underscore/hyphen characters; new run namespace |
| `V2_ALLOWED_PROJECTS`, `V2_ALLOWED_DATABASES` | Nonempty JSON arrays of exact IDs; no wildcards, duplicates or allow/deny overlap |
| `V2_DENIED_PROJECTS` | Nonempty JSON array containing all actual Production project IDs; owner must supply/verify without reading customer data |
| `V2_DENIED_TARGETS` | Nonempty JSON array of exact `project/database` Production pairs |
| `APP_ORIGIN`, `V2_ALLOWED_ORIGINS` | Exact HTTPS origin plus nonempty JSON allowlist; Host must match. Mutations require matching Origin; authenticated GET may omit Origin, but a supplied foreign Origin is rejected |
| `LINE_LOGIN_CHANNEL_ID`, `V2_TEST_LINE_CHANNEL_ID` | Matching Test LINE channel only; not the Production channel |
| `V2_TEST_LINE_SUBJECTS` | Nonempty JSON array of explicitly approved Test LINE user IDs; verified identities outside it are rejected |
| `V2_SERVICE_ACCOUNT_JSON` | Server-only dedicated test service account, matching project and service-account email domain, RSA >=2048-bit key, exact Google token URI |
| `ADMIN_PASSWORD_SALT`, `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET`, `SHEET_SYNC_SECRET` | Separate test secrets on an isolated test host; reuse existing auth format. Entrypoint requires salt >=16, scrypt hash 128 hex characters, session/service secrets >=32 characters |
| `LIFF_ID` | Existing build-time Test LIFF configuration if a test client is subsequently approved; no frontend routing change here |

All IDs above are deployment configuration, not proof that such resources exist. `piyasiri-member-staging` is hard-denied in addition to the mandatory Production denylists. The adapter binds its target/configuration to the instance and rejects changes on subsequent calls. A misconfigured or incomplete denylist still requires owner review; application checks are not a substitute for IAM isolation.

OAuth uses a short-lived RS256 service-account assertion, fixed datastore scope and fixed Google token endpoint, caches the access token in server memory, refreshes before expiry and never logs response bodies/tokens. Redirects are rejected. Credentials are not published to `dist`. This implementation supports service-account JSON only; workload identity federation is not implemented. Supplying any real credential or using OAuth remotely remains a later approval gate. See [Google server-to-server OAuth](https://developers.google.com/identity/protocols/oauth2/service-account).

## Entrypoints and routing

Six additive functions, exposed under `/.netlify/functions/v2-staging-test-` followed by:

- `member-profile`, `member-state`, `reward-redemption`
- `admin-session`, `admin-operations`, `sync-sale-points`

These names do not redirect/replace V1 routes. No frontend calls them yet. No Apps Script contract or reward sync is changed. V2 handlers use existing verified LINE/admin/service authorization, with exact test-subject restrictions and no remote `testMode` redemption bypass or identity-injection hook. V2 admin cookies use `__Host-member_v2_admin`; V1 cookies are not accepted or overwritten. Cross-member detail/cursor guards remain. The service earn route also requires the test service secret and matching origin/host. Admin login necessarily accepts an unauthenticated request only to verify its password and distributed rate budget. V2 admin global read (`member-state?admin=true`) remains disabled; no new admin UI is included.

All authoritative V2 data lives under `v2/{namespace}/{collection}/{id}`. Collections: `customers`, `rewards`, `transactions`, `redemptions`, `secureOperations`, `pendingPurchases`, `lineMembers`, `phoneMembers`, `bills`, `legacyOperationBlocks`, `adminSessions`, `loginAttempts`, `summaryShards`, `counters`, `control`. Financial writers validate `control/writer` (`schemaVersion:2`, `epoch:synthetic-v2`, `writesEnabled:true`) in the same atomic commit. The adapter shares pure financial calculations with V1, never V1 RTDB I/O. No dual writer or migration path is activated.

## Index/IAM requirements — not provisioned

Use the existing `firebase/firestore.local.indexes.json` as the proposed remote index specification:

1. `transactions`: customerId ASC, date DESC.
2. `redemptions`: customerId ASC, date DESC.
3. `pendingPurchases`: customerId ASC, date DESC.
4. `transactions`: customerId ASC, type ASC, expiresAt ASC.
5. `rewards`: visible ASC, id DESC.

Preserve the file's index exclusions for receipt `result` and transaction `pointBreakdown`, `alerts`, `proof`. Confirm implicit document-name ordering and index readiness on the actual service later. Emulator queries do not certify managed indexes. Proposed client rules deny all direct reads/writes; no Rules deployment occurs here.

Dedicated test project/database only. Preferred custom runner role: `datastore.databases.get` (begin/rollback), `datastore.entities.get`, `datastore.entities.list`, `datastore.entities.create`, `datastore.entities.update`, `datastore.entities.delete`. Deletion is needed for profile identity-index changes as well as cleanup. No database/index provisioning, import/export, IAM administration or Production permissions. An approved database-scoped condition may further restrict access; do not claim namespace-level IAM isolation. `roles/datastore.user` is a broader fallback requiring separate review. Index administration belongs to a separate provisioning identity, not the runtime. Server OAuth authorization relies on IAM rather than client Rules. Reference: [Firestore method permission matrix](https://docs.cloud.google.com/firestore/native/docs/security/iam).

No resources are created in this milestone. Before any remote use, independently confirm target IDs, denylist completeness, Test LINE identity, IAM grants, Rules/index readiness, and a genuinely $0 quota envelope. Old paid capacity proposals are not authorization.

## Deadline, retry and financial outcome contract

Remote `store.run` has a 12,000 ms shared I/O budget (OAuth, snapshot reads, rollback, commit and backoff), maximum 12 attempts, unchanged 20–499 ms randomized backoff, and unchanged bounded read/write scope. Tests may lower the deadline but cannot increase it. The emulator timing behavior remains unchanged. Callbacks retain full read-set version/existence preconditions and one atomic commit. Incomplete/duplicate/out-of-scope batch-read responses fail closed.

Only known transaction conflicts retry with a fresh snapshot. Network loss, malformed success response or server error during commit is surfaced as `v2_commit_outcome_unknown_retry_same_key`; it is never declared definitely failed or blindly replayed. Caller must retry the identical authenticated operation/payload/key; committed receipts return the original result and payload mismatch is rejected. Pre-commit deadline errors return `v2_deadline_retry_same_key`. Receipt retention remains mandatory.

The read-only `verify` write representation is used in the [official Firebase JS serializer](https://github.com/firebase/firebase-js-sdk/blob/master/packages/firestore/src/remote/serializer.ts), but is omitted from the [public REST Write schema](https://firebase.google.com/docs/firestore/reference/rest/v1/Write). Emulator success therefore does not certify this server-OAuth REST/IAM combination. Managed-service compatibility (including permission checks for verify operations) must be explicitly verified in a later approved isolated test; do not remove read guards or substitute blind writes to work around a rejection.

This budget is for each database operation, not a guaranteed 15-second end-to-end resolution: LINE verification and separate login/session operations add time. Network outages cannot guarantee a definitive financial result within 15 seconds. No browser recovery UI or remote latency claim is made. Validate whole-request deadlines and same-key recovery with the eventual isolated client before financial E2E approval.

## Cleanup contract

`scripts/v2-cleanup.mjs` exports `cleanupSynthetic`; no automatic CLI execution and no HTTP cleanup endpoint. Default is dry-run. Required namespace must match the guarded store exactly; mutation additionally requires `confirm` equal to that namespace. Only a future approved operator can invoke it with a real transport.

Mutation first atomically disables `control/writer`, invalidating in-flight financial writer preconditions. Enumeration recurses through collection IDs and `showMissing=true` documents so orphan subcollections are included. It uses 50-document pages/batches, updateTime-guarded atomic deletes, a 10,000 visited-node ceiling, 2,000 request ceiling, depth 8 and 60-second soft operator budget (individual RPC may extend this). Control is deleted last. A second recursive scan plus parent lookup must find zero documents. Failure does not claim success; partial cleanup may remain with writer disabled and must be reviewed. Use small test fixtures; do not apply it to archives. Exclude other operator/importer writes during cleanup. Dry-run performs no writer or data mutation. Listing behavior: [Firestore listDocuments](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/listDocuments).

## Artifact and runtime gates

`scripts/check-v2-staging-artifact.mjs` checks the six static function entrypoints and recursive relative import graph, proposed index file, and normalized hashes of 18 V1/config/frontend files at the approved baseline. This establishes source inclusion eligibility for Netlify's functions directory; it cannot prove a future deployed bundle. No Netlify build/deploy or global runtime pin was changed.

V2 validation runner is pinned to **Node 22.23.2** in `scripts/check-v2-node22.mjs`. Run that script with the exact Node executable before the local parity suite; a different runtime fails explicitly. This machine's located executables are **24.19.0 / 24.14.0**. Node 22 parity is **BLOCKED**, not silently relabeled PASS; no download/installation occurred. Existing API usage is Node22-compatible by static review, but that is not execution evidence.

## Local evidence / next review

Mocks sign ephemeral in-memory test keys only. Remote API-shaped requests are intercepted and translated into the owned loopback Firestore emulator; all real external test sockets are denied. Cover configuration omissions/denylists, OAuth signing/refresh/redaction, target escape, deadlines, actual response-loss recovery, shared-reward concurrency, auth/cookie/member isolation, registration/profile/pagination, cancel/complete race, recursive cleanup and V1 regression.

Results and final inventory are recorded in workspace `outputs/v2-adapter-local-run.json`, `outputs/v2-retest-regressions-adapter-local-20261002.txt` and the final review summary. These outputs and emulator binaries/logs are not repository artifacts. Current source must be reviewed before commit; no commit/push/deploy is authorized here. Remaining gates: Node22 execution, reviewed actual target/IAM/index/secret configuration, $0 eligibility, deployed artifact inspection after a separately approved deploy, and eventual remote validation approval. Production, live Staging and RTDB v1 remain untouched.

Local regression result: **138/138 PASS** on Node 24.19.0, no failures/skips: original 98 plus 3 distinct safety-review cases (the other 10 safety checks overlap the 98), plus **37 new adapter checks**. This is not Node22 parity or remote certification. Static artifact check: 18 baseline V1/config/frontend files unchanged, 6 V2 entrypoints, 5 proposed indexes; deployed bundle inspection remains pending. The Node22 preflight intentionally reports a version mismatch on the available Node24 runtime.
