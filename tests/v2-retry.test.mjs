import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, encode, documentData, retryDelayMs } from '../netlify/functions/lib/v2/firestore.mjs';

Object.assign(process.env, { FIRESTORE_V2_MODE: 'emulator', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085',
  FIRESTORE_V2_PROJECT: 'demo-member-v2', CONTEXT: 'test' });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });

for (const status of ['FAILED_PRECONDITION', 'ALREADY_EXISTS', 'NOT_FOUND']) test(`${status} at commit rereads the entire snapshot and recomputes writes`, async () => {
  const begins = [], commits = [], snapshots = [];
  let attempt = 0;
  const store = createStore({ maxAttempts: 2, fetcher: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith(':beginTransaction')) { begins.push(body); return response({ transaction: `token-${++attempt}` }); }
    if (url.endsWith(':batchGet')) return response(body.documents.map(name => ({ found: { name, updateTime: `2026-01-01T00:00:0${attempt}Z`, fields: encode({ points: attempt === 1 ? 100 : 80 }).mapValue.fields } })));
    if (url.endsWith(':commit')) {
      commits.push(body);
      return attempt === 1 ? response({ error: { status } }, 400) : response({});
    }
    assert.ok(url.endsWith(':rollback')); return response({});
  } });
  const value = await store.run(async tx => {
    const customer = await tx.get('customers/TEST'); snapshots.push(customer.points);
    customer.points -= 20; tx.set('customers/TEST', customer); return customer.points;
  });
  assert.deepEqual(snapshots, [100, 80]); assert.equal(value, 60);
  assert.deepEqual(begins, [{ options: { readOnly: {} } }, { options: { readOnly: {} } }]);
  assert.deepEqual(commits.map(c => documentData(c.writes[0].update).points), [80, 60]);
  assert.ok(commits.every(c => !('transaction' in c)));
  assert.deepEqual(commits.map(c => c.writes[0].currentDocument), [{ updateTime: '2026-01-01T00:00:01Z' }, { updateTime: '2026-01-01T00:00:02Z' }]);
});

test('unknown commit response is not blindly replayed inside transport', async () => {
  let commits = 0, begins = 0;
  const store = createStore({ fetcher: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith(':beginTransaction')) { begins++; return response({ transaction: 'token' }); }
    if (url.endsWith(':batchGet')) return response(body.documents.map(missing => ({ missing })));
    if (url.endsWith(':commit')) { commits++; throw Error('synthetic-response-loss'); }
    return response({});
  } });
  await assert.rejects(store.run(async tx => { await tx.get('customers/TEST'); tx.set('customers/TEST', { points: 100 }); }), /synthetic-response-loss/);
  assert.equal(commits, 1); assert.equal(begins, 1);
});

test('business denial rolls back without commit or retry', async () => {
  const calls = [];
  const store = createStore({ fetcher: async url => { calls.push(url.split(':').at(-1)); return response({ transaction: 'token' }); } });
  await assert.rejects(store.run(async () => { throw Error('insufficient_stock'); }), /insufficient_stock/);
  assert.deepEqual(calls, ['beginTransaction', 'rollback']);
});

test('read-only ABORTED retry stays read-only without write lineage', async () => {
  const begins = []; let reads = 0;
  const store = createStore({ maxAttempts: 2, fetcher: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith(':beginTransaction')) { begins.push(body); return response({ transaction: `token-${begins.length}` }); }
    if (url.endsWith(':batchGet')) return ++reads === 1 ? response({ error: { status: 'ABORTED' } }, 409) : response(body.documents.map(missing => ({ missing })));
    assert.ok(url.endsWith(':rollback')); return response({});
  } });
  assert.equal(await store.run(tx => tx.get('customers/TEST'), { readOnly: true }), null);
  assert.deepEqual(begins, [{ options: { readOnly: {} } }, { options: { readOnly: {} } }]);
});

test('optimistic retry jitter is spread and bounded', () => {
  for (let attempt = 0; attempt < 12; attempt++) {
    assert.equal(retryDelayMs(attempt, () => 0), 20);
    const maximum = retryDelayMs(attempt, () => 0.999999);
    assert.ok(maximum >= 99 && maximum < 500);
    assert.ok(retryDelayMs(attempt, () => 0.9) - retryDelayMs(attempt, () => 0.1) >= 64);
  }
});

test('atomic commit guards unchanged, missing, updated and deleted read paths', async () => {
  let commit;
  const store = createStore({ fetcher: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith(':beginTransaction')) return response({ transaction: 'snapshot' });
    if (url.endsWith(':batchGet')) return response(body.documents.map(name => name.endsWith('/missing') ? { missing: name } : {
      found: { name, updateTime: '2026-01-01T00:00:01Z', fields: encode({ points: 100 }).mapValue.fields }
    }));
    if (url.endsWith(':commit')) commit = body;
    return response({});
  } });
  await store.run(async tx => {
    await tx.getMany(['customers/updated', 'customers/deleted', 'control/unchanged', 'customers/missing']);
    tx.set('customers/updated', { points: 80 }); tx.delete('customers/deleted');
  });
  assert.equal(commit.writes.length, 4);
  assert.deepEqual(commit.writes.map(w => w.currentDocument), [
    { updateTime: '2026-01-01T00:00:01Z' }, { updateTime: '2026-01-01T00:00:01Z' },
    { updateTime: '2026-01-01T00:00:01Z' }, { exists: false }
  ]);
  assert.ok(commit.writes[0].update && commit.writes[1].delete);
  assert.ok(commit.writes[2].verify && commit.writes[3].verify);
});

test('missing version fails closed before a financial commit', async () => {
  let commits = 0;
  const store = createStore({ fetcher: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith(':beginTransaction')) return response({ transaction: 'snapshot' });
    if (url.endsWith(':batchGet')) return response(body.documents.map(name => ({ found: { name, fields: {} } })));
    if (url.endsWith(':commit')) commits++;
    return response({});
  } });
  await assert.rejects(store.run(async tx => { await tx.get('customers/TEST'); tx.set('customers/TEST', {}); }), /v2_missing_document_version/);
  assert.equal(commits, 0);
});

test('FAILED_PRECONDITION outside commit is not misclassified as a write race', async () => {
  let begins = 0;
  const store = createStore({ fetcher: async url => {
    if (url.endsWith(':beginTransaction')) { begins++; return response({ transaction: 'snapshot' }); }
    if (url.endsWith(':batchGet')) return response({ error: { status: 'FAILED_PRECONDITION' } }, 400);
    return response({});
  } });
  await assert.rejects(store.run(tx => tx.get('customers/TEST')), /firestore_request_failed/);
  assert.equal(begins, 1);
});
