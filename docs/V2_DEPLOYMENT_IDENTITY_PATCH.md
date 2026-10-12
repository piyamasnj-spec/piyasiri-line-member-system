# V2 deployment identity — local patch

Scope: close the build-to-Functions deployment identity gap only. No external
settings, data, credentials, deployments or financial behavior changed.

`scripts/build-public.mjs` first runs `writeV2BuildIdentity`. It overwrites
`netlify/functions/lib/v2/deployment-identity.mjs` on every build. Exact trusted
build values `CONTEXT=branch-deploy` and `BRANCH=staging` produce a frozen version-1
identity; every other input produces null, replacing any stale staging grant.
Serialization includes only fixed identity fields, never environment secrets.
The checked-in module is null (deny). Never commit the generated staging grant.

`remote.mjs` statically imports the server-only module so the function dependency
graph includes it. Missing/invalid modules cannot initialize; null, malformed or
non-staging identity refuses remote startup. Runtime CONTEXT/BRANCH are optional
consistency checks only: if present they must match. They cannot confer a grant.
Contradictory values added after initialization also fail. No client input selects
the identity, and no reserved environment variables are written or overridden.
All existing target, namespace, OAuth, origin, LINE and auth guards remain.

Trust boundary: the source and Netlify build pipeline are trusted. This does not
attest an artifact copied/promoted outside that pipeline. Production/main builds
always generate a deny artifact; redeployment must use the normal reviewed build,
not promotion/reuse of a staging bundle. No cryptographic deployment attestation
or permission to change Netlify configuration is introduced.

The V1 build body is unchanged. The artifact checker permits exactly the two-line
identity hook and still hashes the original V1 body against its approved baseline.
No frontend or V1 routing changes. This supersedes the older adapter contract's
requirement that reserved CONTEXT/BRANCH must exist at Functions runtime.

Run `tests/v2-deployment-identity.test.mjs` with the existing portable Node 22.23.2.
It builds isolated source copies in OS temp (not the working tree), exercises
denied/allowed artifacts and runs existing remote mock regressions in a generated
staging copy. The remote tests alone now require such a staging artifact, not an
environment-only grant. No real OAuth/Firestore traffic occurs. Existing V1 tests
run with `tests/no-network.mjs`. No emulator/capacity rerun is needed for this patch.

Remaining remote gates: reviewed isolated configuration, IAM/index/rules readiness,
free-tier eligibility, a separately approved new staging artifact, and managed
Firestore verify compatibility. No commit, push or deploy is authorized here.
