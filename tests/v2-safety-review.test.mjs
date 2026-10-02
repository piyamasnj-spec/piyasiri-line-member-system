import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../netlify/functions/lib/v2/firestore.mjs';
import { stableKey } from '../netlify/functions/lib/firebase-rest.mjs';
import { testEnvironment, setup, actor, read, patch, rows } from './v2-helpers.mjs';

const enabled = process.env.FIRESTORE_V2_TESTS === 'true';
if (enabled) testEnvironment();
const check = (name, fn) => test(name, { skip: !enabled }, fn);

async function interceptCommit() {
  let hook;
  const c = await setup({ members: 1 }, { fetcher: async (url, options) => {
    if (url.endsWith(':commit') && hook) {
      const next = hook; hook = undefined; await next();
    }
    return fetch(url, options);
  } });
  return { ...c, peer: createStore({ namespace: c.store.namespace }), beforeCommit: fn => { hook = fn; } };
}

check('ABA writer value restoration still invalidates the old version before one redemption', async () => {
  const c = await interceptCommit(), before = await read(c.peer, 'control/writer');
  c.beforeCommit(async () => {
    await patch(c.peer, 'control/writer', { writesEnabled: false });
    await patch(c.peer, 'control/writer', { writesEnabled: true });
    assert.deepEqual(await read(c.peer, 'control/writer'), before);
  });
  await c.db.financial('redemption', { rewardId: 'TEST-REWARD-0', operationId: 'aba-writer' }, actor(0));
  const metric = c.metrics.find(m => m.label === 'redemption:request');
  assert.equal(metric.attempts, 2); assert.equal(metric.conflicts, 1);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 980);
  assert.equal((await read(c.store, 'rewards/TEST-REWARD-0')).stock, 99);
  for (const collection of ['transactions', 'redemptions']) assert.equal((await rows(c.store, collection)).length, 1);
  assert.ok(await read(c.store, `secureOperations/${stableKey(`redemption:${actor(0).sub}:aba-writer`)}`));
});

check('delete/recreate of identical session data invalidates its old updateTime', async () => {
  const c = await interceptCommit(), path = `adminSessions/${c.admin.sid}`;
  const before = await read(c.peer, path);
  c.beforeCommit(async () => {
    await c.peer.run(async tx => { await tx.get(path); tx.delete(path); });
    await patch(c.peer, path, before);
    assert.deepEqual(await read(c.peer, path), before);
  });
  await c.db.financial('admin', { action: 'counter-sale', operationId: 'aba-session', phone: '0800000000', amount: 1000 }, c.admin);
  const metric = c.metrics.find(m => m.label === 'admin:counter-sale');
  assert.equal(metric.attempts, 2); assert.equal(metric.conflicts, 1);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 1010);
  assert.equal((await rows(c.store, 'transactions')).length, 1);
  assert.ok(await read(c.store, `secureOperations/${stableKey('admin:admin:aba-session')}`));
});

check('persistent version conflicts exhaust the configured bound without partial financial writes', async () => {
  let interfere = false, peer, commits = 0;
  const c = await setup({ members: 1 }, { maxAttempts: 2, fetcher: async (url, options) => {
    if (interfere && url.endsWith(':commit')) {
      commits++;
      await patch(peer, 'control/writer', { syntheticReviewRevision: commits });
    }
    return fetch(url, options);
  } });
  peer = createStore({ namespace: c.store.namespace }); interfere = true;
  await assert.rejects(c.db.financial('redemption', { rewardId: 'TEST-REWARD-0', operationId: 'retry-bound' }, actor(0)), /transaction_busy_retry_same_key/);
  assert.equal(commits, 2);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 1000);
  assert.equal((await read(c.store, 'rewards/TEST-REWARD-0')).stock, 100);
  for (const collection of ['transactions', 'redemptions']) assert.equal((await rows(c.store, collection)).length, 0);
  assert.equal(await read(c.store, `secureOperations/${stableKey(`redemption:${actor(0).sub}:retry-bound`)}`), null);
});
