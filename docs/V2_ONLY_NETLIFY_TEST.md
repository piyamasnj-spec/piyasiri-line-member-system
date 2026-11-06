# V2-only Netlify test deployment — local preparation

No site, credentials, remote fixture, or deployment created. Owner confirms Free
plan, 300 monthly credits, 299.9 remaining, no overage. Team usage remains shared
with V1: exhausting credits can affect other sites. This is not deployment approval.

## Build contract

New site only: repository base is root; package directory `deploy/v2-test` selects
its own `netlify.toml`. Confirm the resolved configuration before any future build:
command `node scripts/build-v2-test.mjs`, publish `dist-v2-test/public`, functions
`dist-v2-test/functions`, Node 22.23.2. Do not edit the existing site's settings or
root config. Do not use `scripts/build-public.mjs` for the new site.

V2 output is outside V1's `dist` publish tree. Nested V1 output overrides are
refused. If legacy `dist/v2-test` exists, V2 build stops before writing anything:
use a clean workspace before proceeding to V1 build. No automatic deletion is
performed. Running V1 independently in a contaminated workspace still retains
old files; V1 is unchanged. Never publish that workspace. `dist-v2-test` is generated
output, not a commit candidate (this patch does not change the shared gitignore).

Only trusted build CONTEXT=branch-deploy and BRANCH=staging emit six endpoints.
Every other context emits an inert page and zero endpoints. A stale output with
extra files causes build failure, not silent reuse. Use a clean workspace if this
occurs; do not bypass the check. Runtime CONTEXT/BRANCH cannot grant identity.

Do not select staging as the new site's production branch: that has production
context and deliberately emits zero functions. A separate inert bootstrap branch
and branch-deploy staging configuration need later approval. Do not change main.
Do not connect the repository until the isolated config exists on the selected
branch: initial import may immediately start a build.

The modern default exports use native Request/Response (no dependencies added).
Keep default function URLs; no custom route, schedule, V1 UI or customer JS is
published. All six names remain `v2-staging-test-<operation>`.

V2 already imports pure business exports from V1 modules. Byte-identical copies
of these modules and their dependencies live under `server`, OUTSIDE the Functions
and publish directories. They are server bundle dependencies, not deployed V1
entrypoints. This includes the notification module transitively imported by sale
logic; V2 does not invoke notification behavior. No financial logic is rewritten.
Future Netlify artifact verification must confirm exactly six deployed functions.

## Environment isolation

Use site-local, staging-only values; never import V1 or team-shared credentials.
Modern adapter refuses FIREBASE_DATABASE_URL, FIREBASE_SERVICE_ACCOUNT_JSON and
LINE_CHANNEL_ACCESS_TOKEN when nonempty. Do not put secrets in build output,
source, public files, logs, or this document. No secret env values are read by build.

Runtime Functions scope, branch staging only:
- FIRESTORE_V2_MODE=staging-test; V2_STAGING_TEST_ENABLED=true
- FIRESTORE_V2_PROJECT=piyasiri-member-v2-test
- FIRESTORE_V2_DATABASE=(default)
- FIRESTORE_V2_NAMESPACE=synthetic-v2-preflight-001
- V2_ALLOWED_PROJECTS / V2_ALLOWED_DATABASES: JSON arrays containing only that target
- V2_DENIED_PROJECTS: include piyasiri-member-system and piyasiri-member-staging
- V2_DENIED_TARGETS: JSON array including each denied project/(default)
- APP_ORIGIN: exact HTTPS staging branch origin of the NEW site, no trailing slash
- V2_ALLOWED_ORIGINS: JSON array containing only APP_ORIGIN
- V2_SERVICE_ACCOUNT_JSON: only the isolated V2 project's server identity
- LINE_LOGIN_CHANNEL_ID and V2_TEST_LINE_CHANNEL_ID: same dedicated V2 test channel
- V2_TEST_LINE_SUBJECTS: JSON array of permitted test subjects
- ADMIN_PASSWORD_SALT, ADMIN_PASSWORD_HASH, ADMIN_SESSION_SECRET, SHEET_SYNC_SECRET:
  NEW independent V2 values, despite existing variable names. Never copy V1 values.

Do not override reserved CONTEXT/BRANCH. Functions-scoped environment needs no
Builds scope for this build. If the plan cannot restrict scopes, the build still
does not serialize env; verify effective context before any future deployment.
No automatic way exists to prove a newly supplied secret differs from V1 without
comparing secrets: independent generation/ownership remains a setup checkpoint.

Dedicated V2 LINE Login/LIFF configuration is a later task. This artifact has no
login/customer frontend. A future test harness must be same-origin; set callback
and LIFF endpoint only for V2. Never change V1 LINE configuration. Keep the existing
host-only __Host-member_v2_admin cookie, Secure/HttpOnly/SameSite=Strict and exact
Origin/Host validation. No CORS wildcard or cross-site cookie relaxation.

## Verification and limits

Node 22.23.2: artifact/HTTP boundary suite now 14 pass, 0 fail, 0 skip after output
isolation patch. V2 build/rebuild followed by V1 build preserves V1 static output
byte-for-byte, including harmless prior output; legacy nested artifacts refuse
the sequence without deletion. Output overrides inside V1 publish are rejected.
Existing selected regressions (previous milestone, not rerun for path-only patch)
112 pass, 0 fail, 3 emulator-only safety checks skipped; nested remote mocks 31 pass.
No emulator financial tests repeated; underlying financial/verify/guard sources
are unchanged and artifact tests compare V2 dependencies byte-for-byte.
Network disabled in offline regression processes. Test artifacts use OS temp only.

Checks cover six modern exports/import closure; no public metadata/secret canary;
missing remote config denies; non-staging contexts emit no functions; stale output
refusal; 100KB streamed body bound; cookie/auth preservation; Origin/Host mapping;
duplicate-query refusal; error redaction and forbidden V1 credential rejection.

Still unproven: Netlify bundler/runtime and actual six-function deployment, managed
Firestore verify/IAM compatibility, site-local variable setup and dedicated LINE
flow. No remote behavior is certified by these local tests. Next: review this local
patch and its commit grouping; no automatic commit, push, site creation or deploy.
