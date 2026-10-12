import test from 'node:test';
import assert from 'node:assert/strict';
import { verify, createPublicKey } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { remoteConfig, createRemoteTransport } from '../netlify/functions/lib/v2/remote.mjs';
import { createStore } from '../netlify/functions/lib/v2/firestore.mjs';
import { cleanupSynthetic } from '../scripts/v2-cleanup.mjs';
import { remoteEnvironment, response, oauthResponse } from './v2-remote-helpers.mjs';
import { checkArtifacts } from '../scripts/check-v2-staging-artifact.mjs';

for (const [name, change] of Object.entries({
  production: { CONTEXT: 'production' }, unknownContext: { CONTEXT: 'deploy-preview' }, wrongBranch: { BRANCH: 'main' },
  missingMode: { FIRESTORE_V2_MODE: '' }, missingFlag: { V2_STAGING_TEST_ENABLED: '' },
  wrongProject: { FIRESTORE_V2_PROJECT: 'wrong-project' }, wrongDatabase: { FIRESTORE_V2_DATABASE: 'wrong-database' },
  productionProject: { FIRESTORE_V2_PROJECT: 'synthetic-prod-denied', V2_ALLOWED_PROJECTS: '["synthetic-prod-denied"]' },
  productionPair: { V2_DENIED_TARGETS: '["synthetic-v2-test/(default)"]' },
  liveStaging: { FIRESTORE_V2_PROJECT: 'piyasiri-member-staging', V2_ALLOWED_PROJECTS: '["piyasiri-member-staging"]' },
  nonSynthetic: { FIRESTORE_V2_NAMESPACE: 'customers' }, bareNamespace: { FIRESTORE_V2_NAMESPACE: 'synthetic' },
  missingOAuth: { V2_SERVICE_ACCOUNT_JSON: '' }, missingDenylist: { V2_DENIED_PROJECTS: '' },
  wildcard: { V2_ALLOWED_PROJECTS: '["*"]' }, wrongOrigin: { APP_ORIGIN: 'https://other.invalid' },
  emulatorAmbiguity: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085' }, wrongLineChannel: { LINE_LOGIN_CHANNEL_ID: 'different' }
})) test(`remote fail closed: ${name}`, () => assert.throws(() => createRemoteTransport({ env: { ...remoteEnvironment(), ...change }, fetcher: () => { throw Error('network must not run'); } }), /v2_remote_configuration_denied/));

test('all required configuration omissions refuse startup without network', () => {
  const env = remoteEnvironment();
  for (const key of Object.keys(env).filter(k => !['CONTEXT', 'BRANCH'].includes(k))) { const copy = { ...env }; delete copy[key]; assert.throws(() => remoteConfig(copy), /v2_remote_configuration_denied/, key); }
});
test('OAuth identity/token URL must belong to exact test project', () => {
  for (const change of [{ project_id: 'wrong-project' }, { client_email: 'other@wrong-project.iam.gserviceaccount.com' }, { token_uri: 'https://bad.invalid/token' }, { private_key: 'invalid' }]) {
    const env = remoteEnvironment(); env.V2_SERVICE_ACCOUNT_JSON = JSON.stringify({ ...JSON.parse(env.V2_SERVICE_ACCOUNT_JSON), ...change });
    assert.throws(() => remoteConfig(env), /v2_remote_configuration_denied/);
  }
});
test('OAuth signs restricted JWT, caches and refreshes; only fixed endpoints and redirect error', async () => {
  const env = remoteEnvironment(); let clock = Date.now(), tokens = 0, calls = 0;
  const transport = createRemoteTransport({ env, now: () => clock, fetcher: async (url, o) => {
    assert.equal(o.redirect, 'error'); calls++;
    if (url === 'https://oauth2.googleapis.com/token') {
      tokens++; const jwt = new URLSearchParams(o.body).get('assertion').split('.');
      const claims = JSON.parse(Buffer.from(jwt[1], 'base64url'));
      assert.equal(claims.aud, url); assert.equal(claims.scope, 'https://www.googleapis.com/auth/datastore'); assert.equal(claims.exp - claims.iat, 600);
      assert.ok(verify('RSA-SHA256', Buffer.from(jwt.slice(0,2).join('.')), createPublicKey(JSON.parse(env.V2_SERVICE_ACCOUNT_JSON).private_key), Buffer.from(jwt[2], 'base64url')));
      return oauthResponse();
    }
    assert.ok(url.startsWith('https://firestore.googleapis.com/v1/projects/synthetic-v2-test/'));
    assert.equal(o.headers.Authorization, 'Bearer synthetic-mock-access'); return response({ transaction: 'snapshot' });
  } });
  const body = { options: { readOnly: {} } };
  await transport.request(':beginTransaction', body); await transport.request(':beginTransaction', body);
  assert.equal(tokens, 1); clock += 3_600_000; await transport.request(':beginTransaction', body); assert.equal(tokens, 2);
  env.CONTEXT = 'production'; await assert.rejects(transport.request(':beginTransaction', body), /configuration_denied/); assert.equal(calls, 5);
});
test('OAuth failure is redacted and never sends Firestore request', async () => {
  let calls = 0;
  const t = createRemoteTransport({ env: remoteEnvironment(), fetcher: async () => { calls++; throw Error('sensitive mock response'); } });
  await assert.rejects(t.request(':beginTransaction', { options: { readOnly: {} } }), e => e.message === 'v2_oauth_unavailable'); assert.equal(calls, 1);
});
test('transport denies escaping namespace, unguarded commit and collection group query before OAuth', async () => {
  const t = createRemoteTransport({ env: remoteEnvironment(), fetcher: () => { throw Error('network must not run'); } });
  for (const [suffix, body] of [
    [':batchGet', { documents: [t.prefix.replace('/synthetic-', '/other-') + '/customers/a'] }],
    [':commit', { writes: [{ delete: t.prefix + '/customers/a' }] }],
    [`/v2/${t.namespace}:runQuery`, { transaction: 'x', structuredQuery: { from: [{ collectionId: 'customers', allDescendants: true }], limit: 1 } }],
    ['/../../other:listCollectionIds', {}]
  ]) await assert.rejects(t.request(suffix, body), /configuration_denied/);
});

function fakeStore({ loss = false, stall = false, incomplete = false, busy = false, deadlineMs = 12_000 } = {}) {
  const env = remoteEnvironment(); let commits = 0, begins = 0;
  const t = createRemoteTransport({ env, fetcher: async (url, o) => {
    if (url.includes('oauth2.googleapis.com')) return oauthResponse();
    const b = JSON.parse(o.body);
    if (url.endsWith(':beginTransaction')) { begins++; return response({ transaction: 'snapshot' }); }
    if (url.endsWith(':batchGet')) return response(incomplete ? [] : b.documents.map(missing => ({ missing })));
    if (url.endsWith(':commit')) {
      commits++;
      if (loss) throw Error('lost response');
      if (stall) await delay(60_000, undefined, { signal: o.signal });
      if (busy) return response({ error: { status: 'ABORTED' } }, 409);
    }
    return response({});
  } });
  return { store: createStore({ transport: t, namespace: t.namespace, maxAttempts: 2, deadlineMs }), counts: () => ({ commits, begins }) };
}
const mutate = store => store.run(async tx => { await tx.get('customers/TEST'); tx.set('customers/TEST', { points: 100 }); });
test('unknown remote commit outcome escapes once and instructs same-key recovery', async () => {
  const c = fakeStore({ loss: true }); await assert.rejects(mutate(c.store), /v2_commit_outcome_unknown_retry_same_key/); assert.deepEqual(c.counts(), { commits: 1, begins: 1 });
});
test('remote commit timeout is bounded and never blindly retries', async () => {
  const c = fakeStore({ stall: true, deadlineMs: 100 }); const start = performance.now();
  await assert.rejects(mutate(c.store), /v2_commit_outcome_unknown_retry_same_key/); assert.ok(performance.now() - start < 1500); assert.equal(c.counts().commits, 1);
});
test('deadline before write makes no commit; incomplete read set fails closed', async () => {
  const c = fakeStore({ deadlineMs: 10 });
  await assert.rejects(c.store.run(async tx => { await tx.get('customers/TEST'); await delay(30); tx.set('customers/TEST', { points: 100 }); }), /v2_deadline_retry_same_key/);
  assert.equal(c.counts().commits, 0);
  const d = fakeStore({ incomplete: true }); await assert.rejects(mutate(d.store), /v2_incomplete_read_set/); assert.equal(d.counts().commits, 0);
});
test('remote conflict retries remain bounded and report same-key retry', async () => {
  const c = fakeStore({ busy: true }); await assert.rejects(mutate(c.store), /transaction_busy_retry_same_key/); assert.deepEqual(c.counts(), { commits: 2, begins: 2 });
});
test('cleanup guards reject missing namespace, non-test namespace, mismatched confirmation and oversized budget before requests', async () => {
  const store = { namespace: 'synthetic-test', assertTarget() {}, request() { throw Error('network must not run'); } };
  for (const o of [{}, { namespace: 'production' }, { namespace: 'synthetic-other' }, { namespace: store.namespace, dryRun: false }, { namespace: store.namespace, maxDocuments: 10001 }]) await assert.rejects(cleanupSynthetic(store, o), /v2_cleanup_guard/);
});
test('static artifact graph includes V2 dependencies and preserves V1 endpoints/routing', () => {
  const result = checkArtifacts(); assert.equal(result.v2Entrypoints, 6); assert.equal(result.v1FilesUnchanged, 18); assert.ok(result.dependencyModules >= 11);
});
test('all six isolated entrypoints refuse Production before any network', async () => {
  const previous = process.env.CONTEXT; process.env.CONTEXT = 'production';
  try {
    for (const op of ['member-profile','member-state','reward-redemption','admin-operations','admin-session','sync-sale-points']) {
      const { handler } = await import(`../netlify/functions/v2-staging-test-${op}.mjs`);
      const result = await handler({ httpMethod: 'POST', body: '{}' });
      assert.equal(result.statusCode, 503); assert.equal(JSON.parse(result.body).status, 'v2_remote_configuration_denied');
    }
  } finally { if (previous === undefined) delete process.env.CONTEXT; else process.env.CONTEXT = previous; }
});
test('remote entrypoint refuses missing server auth configuration before OAuth', async () => {
  const old = { ...process.env };
  try {
    Object.assign(process.env, remoteEnvironment()); delete process.env.FIRESTORE_EMULATOR_HOST; delete process.env.ADMIN_SESSION_SECRET;
    const { handler } = await import('../netlify/functions/v2-staging-test-member-state.mjs');
    const result = await handler({ httpMethod: 'GET', headers: {} });
    assert.equal(result.statusCode, 503); assert.equal(JSON.parse(result.body).status, 'v2_server_auth_not_configured');
  } finally { for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old); }
});
