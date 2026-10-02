import test, { after } from 'node:test';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createStore, emulatorTarget, encode } from '../netlify/functions/lib/v2/firestore.mjs';
import { stableKey } from '../netlify/functions/lib/firebase-rest.mjs';
import { redeem } from '../netlify/functions/reward-redemption.mjs';
import { planSyntheticImport } from '../scripts/v2-synthetic-fixture.mjs';
import { testEnvironment, setup, actor, event, read, patch, rows, fixture, importSynthetic, metricSamples } from './v2-helpers.mjs';
const enabled = process.env.FIRESTORE_V2_TESTS === 'true';
if (enabled) testEnvironment();
const check = (name, fn) => test(name, { skip: !enabled }, fn);
const request = (operationId = 'request') => ({ rewardId: 'TEST-REWARD-0', operationId });
if (enabled) after(async () => {
  const financial = metricSamples.filter(m => /^(redemption|admin|sale):/.test(m.label));
  const summary = Object.fromEntries([...new Set(financial.map(m => m.label))].map(label => {
    const all = financial.filter(m => m.label === label), success = all.filter(m => m.ok);
    return [label, { requests: all.length, successes: success.length, maxDocsRead: Math.max(0, ...success.map(m => m.docsRead)), maxDocsWritten: Math.max(0, ...success.map(m => m.docsWritten)), maxLogicalBytes: Math.max(0, ...success.map(m => m.logicalBytes)), maxCommitBytes: Math.max(0, ...success.map(m => m.commitBytes)), conflicts: all.reduce((n, m) => n + m.conflicts, 0) }];
  }));
  await writeFile(new URL('../../../outputs/v2-financial-metrics.json', import.meta.url), JSON.stringify(summary, null, 2));
});

check('v2 environment refuses remote, Production context and live project before network', () => {
  for (const extra of [{ CONTEXT: 'production' }, { FIRESTORE_EMULATOR_HOST: 'example.com:8085' }, { FIRESTORE_V2_PROJECT: 'piyasiri-member-staging' }, { FIRESTORE_V2_MODE: '' }]) assert.throws(() => emulatorTarget({ ...process.env, ...extra }), /v2_local_emulator_only/);
  assert.throws(() => createStore({ namespace: 'active' }), /synthetic_namespace_required/);
});
check('emulator rules deny direct unauthenticated reads/writes', async () => {
  const { store } = await setup({ members: 1 });
  const url = `http://127.0.0.1:8085/v1/${store.name('customers/TEST-MEMBER-0')}`;
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: encode({ points: 99999 }).mapValue.fields }) })).status, 403);
  assert.equal((await read(store, 'customers/TEST-MEMBER-0')).points, 1000);
});
check('unauthorized/forged admin, invalid LINE, wrong origin rejected', async () => {
  const c = await setup({ members: 1 });
  for (const headers of [{}, { origin: process.env.APP_ORIGIN, cookie: '__Host-member_admin=forged' }, { ...c.headers, origin: 'https://bad.invalid' }]) assert.equal((await c.handlers['admin-operations'](event({ action: 'counter-sale', operationId: 'earn', phone: '0800000000', amount: 1000 }, headers))).statusCode >= 400, true);
  assert.equal((await c.handlers['reward-redemption'](event(request(), { authorization: 'Bearer bad' }))).statusCode, 401);
  assert.equal((await c.handlers['member-state'](event({}, {}, 'GET'))).statusCode, 401);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 1000);
});
check('admin login, authorized earn, logout and revoked-session rejection', async () => {
  const c = await setup({ members: 1 });
  const login = await c.handlers['admin-session'](event({ action: 'login', password: 'synthetic-admin-password' }, { origin: process.env.APP_ORIGIN }));
  assert.equal(login.statusCode, 200);
  const headers = { origin: process.env.APP_ORIGIN, cookie: login.headers['Set-Cookie'].split(';')[0] };
  const body = { action: 'counter-sale', operationId: 'earn', phone: '0800000000', amount: 1000 };
  assert.equal((await c.handlers['admin-operations'](event(body, headers))).statusCode, 200);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 1010);
  assert.equal((await c.handlers['admin-session'](event({ action: 'logout' }, headers))).statusCode, 200);
  assert.equal((await c.handlers['admin-operations'](event({ ...body, operationId: 'after-logout' }, headers))).statusCode, 401);
});
check('member register/profile keeps whitelist and stable identity across retry', async () => {
  const c = await setup({ members: 1 });
  const headers = { authorization: 'Bearer synthetic-99' }, body = { name: 'SYNTHETIC new member', phone: '0899999999', birthday: '', area: 'test' };
  const a = JSON.parse((await c.handlers['member-profile'](event(body, headers))).body);
  assert.equal(a.created, true);
  const b = JSON.parse((await c.handlers['member-profile'](event({ ...body, name: 'SYNTHETIC edited' }, headers))).body);
  assert.equal(b.customer.id, a.customer.id); assert.equal(b.created, false); assert.equal(b.customer.points, 0);
  assert.equal((await c.handlers['member-profile'](event({ ...body, points: 500 }, headers))).statusCode, 400);
  const phoneEdit = await c.db.profile({ ...body, phone: '0877777777' }, actor(99));
  assert.equal(phoneEdit.customer.id, a.customer.id);
  assert.equal(await read(c.store, `phoneMembers/${stableKey(body.phone)}`), null);
});
check('concurrent registration with same LINE/phone creates one member/code', async () => {
  const c = await setup({ members: 1 }); const body = { name: 'SYNTHETIC concurrent', phone: '0899999998', area: '', birthday: '' };
  const replies = await Promise.all([c.db.profile(body, actor(98)), c.db.profile(body, actor(98))]);
  assert.equal(replies[0].customer.id, replies[1].customer.id);
  assert.equal((await read(c.store, 'counters/memberCode')).lastAllocated, 2);
  await assert.rejects(c.db.profile(body, actor(97)), /phone_already_registered/);
});
check('redemption creates balance/stock/debit/redemption/receipt in one commit', async () => {
  const c = await setup({ members: 1 });
  const result = await c.db.financial('redemption', request(), actor(0));
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 980);
  const reward = await read(c.store, 'rewards/TEST-REWARD-0'); assert.equal(reward.stock, 99); assert.equal(reward.stockVersion, 1);
  assert.equal((await read(c.store, `transactions/${result.transactionId}`)).redemptionId, result.redemptionId);
  assert.equal((await read(c.store, `redemptions/${result.redemptionId}`)).transactionId, result.transactionId);
  const hash = stableKey(`redemption:${actor(0).sub}:request`);
  assert.deepEqual((await read(c.store, `secureOperations/${hash}`)).result, result);
});
check('simultaneous same-key duplicates create one debit, exact retry; mismatch rejected', async () => {
  const c = await setup({ members: 1 });
  const [a, b] = await Promise.all([c.db.financial('redemption', request(), actor(0)), c.db.financial('redemption', request(), actor(0))]);
  assert.equal(a.transactionId, b.transactionId);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 980);
  assert.equal((await rows(c.store, 'transactions')).length, 1);
  await assert.rejects(c.db.financial('redemption', { ...request(), quantity: 2 }, actor(0)), /idempotency_payload_mismatch/);
  await patch(c.store, 'rewards/TEST-REWARD-0', { points: 50 });
  const retry = await c.db.financial('redemption', request(), actor(0)); assert.equal(retry.points, 20); assert.equal(retry.totalPoints, 980);
});
check('response lost after real commit: retry same key returns committed receipt', async () => {
  let lose = false;
  const c = await setup({ members: 1 }, { fetcher: async (url, options) => { const r = await fetch(url, options); if (lose && url.endsWith(':commit') && r.ok) { lose = false; await r.text(); throw Error('synthetic response loss after commit'); } return r; } });
  lose = true;
  await assert.rejects(c.db.financial('redemption', request(), actor(0)), /response loss/);
  const retry = await c.db.financial('redemption', request(), actor(0)); assert.equal(retry.replayed, true);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 980); assert.equal((await rows(c.store, 'transactions')).length, 1);
});
check('failure before commit leaves no partial debit, reservation or receipt', async () => {
  let fail = false;
  const c = await setup({ members: 1 }, { fetcher: async (url, options) => { if (fail && url.endsWith(':commit')) { fail = false; throw Error('synthetic precommit failure'); } return fetch(url, options); } });
  fail = true; await assert.rejects(c.db.financial('redemption', request(), actor(0)), /precommit failure/);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 1000); assert.equal((await read(c.store, 'rewards/TEST-REWARD-0')).stock, 100);
  assert.equal((await rows(c.store, 'redemptions')).length, 0);
  assert.equal(await read(c.store, `secureOperations/${stableKey(`redemption:${actor(0).sub}:request`)}`), null);
});
check('insufficient points/stock, inactive reward and member mismatch are all-or-nothing', async () => {
  const c = await setup({ members: 1 });
  await assert.rejects(c.db.financial('redemption', { ...request(), memberId: 'OTHER' }, actor(0)), /member_mismatch/);
  await patch(c.store, 'customers/TEST-MEMBER-0', { points: 10 });
  await assert.rejects(c.db.financial('redemption', request(), actor(0)), /insufficient_points/);
  await patch(c.store, 'customers/TEST-MEMBER-0', { points: 1000 }); await patch(c.store, 'rewards/TEST-REWARD-0', { stock: 0 });
  await assert.rejects(c.db.financial('redemption', request(), actor(0)), /insufficient_stock/);
  await patch(c.store, 'rewards/TEST-REWARD-0', { stock: 100, active: false });
  await assert.rejects(c.db.financial('redemption', request(), actor(0)), /reward_inactive/);
  assert.equal((await rows(c.store, 'transactions')).length, 0);
});
check('cancel refunds stored cost/reservation once despite new key and changed price', async () => {
  const c = await setup({ members: 1 }); const r = await c.db.financial('redemption', request(), actor(0));
  await patch(c.store, 'rewards/TEST-REWARD-0', { points: 99 });
  const cancel = { action: 'cancel', redemptionId: r.redemptionId, operationId: 'cancel' };
  await c.db.financial('redemption', cancel, c.admin); await c.db.financial('redemption', cancel, c.admin); await c.db.financial('redemption', { ...cancel, operationId: 'another-cancel' }, c.admin);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 1000); assert.equal((await read(c.store, 'rewards/TEST-REWARD-0')).stock, 100);
  assert.equal((await rows(c.store, 'transactions')).filter(t => t.type === 'refund').length, 1);
  assert.equal((await c.db.state(actor(0))).summaries.pendingRedemptions, 0);
});
check('cancel/complete race reaches exactly one final state and correct refund', async () => {
  const c = await setup({ members: 1 }); const r = await c.db.financial('redemption', request(), actor(0));
  const outcomes = await Promise.allSettled(['cancel', 'complete'].map(action => c.db.financial('redemption', { action, redemptionId: r.redemptionId, operationId: action }, c.admin)));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const final = await read(c.store, `redemptions/${r.redemptionId}`), cancelled = final.status === 'cancelled';
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, cancelled ? 1000 : 980);
  assert.equal((await read(c.store, 'rewards/TEST-REWARD-0')).stock, cancelled ? 100 : 99);
  assert.equal((await rows(c.store, 'transactions')).filter(t => t.type === 'refund').length, cancelled ? 1 : 0);
  assert.equal((await c.db.state(actor(0))).summaries.pendingRedemptions, 0);
});
check('unlimited stock remains unlimited through request/cancel; unknown reservation blocked', async () => {
  const c = await setup({ members: 1 }); await patch(c.store, 'rewards/TEST-REWARD-0', { stock: '' });
  const r = await c.db.financial('redemption', request(), actor(0)); await c.db.financial('redemption', { action: 'cancel', redemptionId: r.redemptionId, operationId: 'c' }, c.admin);
  assert.equal((await read(c.store, 'rewards/TEST-REWARD-0')).stock, '');
  const r2 = await c.db.financial('redemption', request('next'), actor(0));
  await c.store.run(async tx => { const path = `redemptions/${r2.redemptionId}`, old = await tx.get(path); delete old.stockReserved; delete old.stockBefore; tx.set(path, old); });
  await assert.rejects(c.db.financial('redemption', { action: 'cancel', redemptionId: r2.redemptionId, operationId: 'c2' }, c.admin), /legacy_redemption_requires_reconciliation/);
});
check('sale earn/recalculate/reverse preserve bill index, receipts and existing IDs', async () => {
  const c = await setup({ members: 1 }), service = { role: 'service', sub: 'sheet' };
  const body = { phone: '66800000000', ref: 'TEST-BILL', transactionId: 'TEST-EARN', pointResult: { points: 10, amount: 1000, breakdown: [{ points: 10 }] } };
  const first = await c.db.financial('sale', body, service); assert.equal(first.transactionId, 'TEST-EARN');
  assert.equal((await c.db.financial('sale', body, service)).replayed, true);
  const recalc = await c.db.financial('sale', { ...body, action: 'recalculate', operationId: 'recalc', transactionId: 'TEST-RECALC', pointResult: { points: 15, amount: 1500, breakdown: [{ points: 15 }] } }, service);
  assert.equal(recalc.totalPoints, 1015);
  const reverse = await c.db.financial('sale', { action: 'reverse', ref: 'TEST-BILL', transactionId: 'TEST-REVERSE' }, service); assert.equal(reverse.totalPoints, 1000);
  assert.equal((await read(c.store, 'transactions/TEST-EARN')).status, 'revised');
  assert.equal((await read(c.store, 'transactions/TEST-RECALC')).status, 'reversed');
});
check('transactional session revocation is rechecked after handler authentication', async () => {
  const c = await setup({ members: 1 });
  await patch(c.store, `adminSessions/${c.admin.sid}`, { revoked: true });
  await assert.rejects(c.db.financial('admin', { action: 'counter-sale', operationId: 'revoked', phone: '0800000000', amount: 100 }, c.admin), /unauthorized/);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 1000);
});
check('member history paginates with correct summaries, stable ties, ownership and no global history', async () => {
  const c = await setup({ members: 2, history: 80 });
  const r = await c.db.financial('redemption', request(), actor(0));
  const first = await c.db.state(actor(0), { limit: 3 }); assert.equal(first.state.transactions.length, 3); assert.equal(first.summaries.points, 980); assert.equal(first.summaries.pendingRedemptions, 1);
  assert.equal(first.summaries.nextExpiry.expiresAt, '2024-01-01T00:00:00.000Z');
  const seen = [...first.state.transactions]; let cursor = first.pages.transactions.cursor;
  while (cursor) { const next = await c.db.state(actor(0), { limit: 3, cursors: { transactions: cursor } }); seen.push(...next.state.transactions); cursor = next.pages.transactions.cursor; }
  assert.equal(seen.length, 41); assert.equal(new Set(seen.map(t => t.id)).size, 41); assert.ok(seen.every(t => t.customerId === 'TEST-MEMBER-0'));
  await assert.rejects(c.db.state(actor(1), { cursors: { transactions: first.pages.transactions.cursor } }), /invalid_history_cursor/);
  assert.equal((await c.db.state(actor(0))).state.redemptions[0].id, r.redemptionId);
});
check('migration preserves old financial IDs, operation fingerprint and exact replay without debit', async () => {
  const envelope = fixture({ members: 1 });
  const prior = redeem(envelope.root, request('old-key'), actor(0));
  const old = structuredClone(envelope.root.secureOperations);
  const c = await setup({ envelope });
  const replay = await c.db.financial('redemption', request('old-key'), actor(0)); assert.deepEqual(replay, { ...prior, replayed: true });
  for (const [id, row] of Object.entries(old)) assert.deepEqual(await read(c.store, `secureOperations/${id}`), row);
  assert.equal((await read(c.store, `transactions/${prior.transactionId}`)).id, prior.transactionId);
  assert.equal((await read(c.store, `redemptions/${prior.redemptionId}`)).id, prior.redemptionId);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 980);
  await assert.rejects(importSynthetic(c.store, envelope));
  const bad = structuredClone(envelope); bad.root.customers['TEST-MEMBER-0'].id = 'different'; assert.throws(() => planSyntheticImport(bad), /synthetic customer/);
});
check('document and aggregate budgets fail before any writes', async () => {
  const c = await setup({ members: 1 });
  await assert.rejects(c.store.run(async tx => { const paths = Array.from({ length: 21 }, (_, i) => `transactions/TEST-BUDGET-${i}`); await tx.getMany(paths); }), /budget_exceeded/);
  await assert.rejects(c.store.run(async tx => { await tx.get('rewards/TEST-REWARD-0'); tx.set('rewards/TEST-REWARD-0', { description: 'x'.repeat(17000) }); }), /document_budget_exceeded/);
  await assert.rejects(c.store.run(async tx => { for (let i = 0; i < 5; i++) { const p = `transactions/TEST-LARGE-${i}`; await tx.get(p); tx.set(p, { id: `TEST-LARGE-${i}`, text: 'x'.repeat(120000) }); } }), /transaction_budget_exceeded/);
  assert.equal(await read(c.store, 'transactions/TEST-LARGE-0'), null); assert.equal((await read(c.store, 'rewards/TEST-REWARD-0')).stock, 100);
});
check('distinct operation IDs cannot jointly overspend one member balance', async () => {
  const envelope = fixture({ members: 1 }); envelope.root.customers['TEST-MEMBER-0'].points = 30;
  const c = await setup({ envelope });
  const replies = await Promise.allSettled(['first', 'second'].map(id => c.db.financial('redemption', request(id), actor(0))));
  assert.equal(replies.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(replies.find(r => r.status === 'rejected').reason.message, 'insufficient_points');
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 10);
  assert.equal((await c.db.summary(c.admin)).totalPoints, 10);
});
check('concurrent earn, redemption and profile preserve every update and summary', async () => {
  const c = await setup({ members: 1 });
  await Promise.all([
    c.db.financial('admin', { action: 'counter-sale', operationId: 'earn-race', phone: '0800000000', amount: 1000 }, c.admin),
    c.db.financial('redemption', request('spend-race'), actor(0)),
    c.db.profile({ name: 'SYNTHETIC new profile', phone: '0800000000', area: 'changed', birthday: '' }, actor(0))
  ]);
  const customer = await read(c.store, 'customers/TEST-MEMBER-0'); assert.equal(customer.points, 990); assert.equal(customer.area, 'changed');
  assert.equal((await c.db.summary(c.admin)).totalPoints, 990);
});
check('pending approval/reject race and reward catalog operations remain atomic', async () => {
  const envelope = fixture({ members: 1 });
  envelope.root.pendingPurchases['TEST-PENDING'] = { id: 'TEST-PENDING', customerId: 'TEST-MEMBER-0', status: 'pending', amount: 1000, date: '2026-01-01T00:00:00.000Z' };
  const c = await setup({ envelope });
  const replies = await Promise.allSettled(['approve', 'reject'].map(action => c.db.financial('admin', { action, id: 'TEST-PENDING', amount: 1000, operationId: action }, c.admin)));
  assert.equal(replies.filter(r => r.status === 'fulfilled').length, 1);
  const p = await read(c.store, 'pendingPurchases/TEST-PENDING');
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, p.status === 'approved' ? 1010 : 1000);
  assert.equal((await c.db.summary(c.admin)).pendingPurchaseCount, 0);
  const added = await c.db.financial('admin', { action: 'reward-add', operationId: 'add', reward: { name: 'SYNTHETIC NEW', points: 10, stock: 1, active: true } }, c.admin);
  assert.ok((await c.db.state(actor(0))).state.rewards.some(r => r.id === added.rewardId));
  await c.db.financial('admin', { action: 'reward-archive', id: added.rewardId, operationId: 'archive' }, c.admin);
  assert.ok(!(await c.db.state(actor(0))).state.rewards.some(r => r.id === added.rewardId));
});
check('concurrent logout and financial mutation serialize; no subsequent mutation accepted', async () => {
  const c = await setup({ members: 1 });
  const body = { action: 'counter-sale', operationId: 'logout-race', phone: '0800000000', amount: 1000 };
  const [logout, earn] = await Promise.all([
    c.handlers['admin-session'](event({ action: 'logout' }, c.headers)),
    c.handlers['admin-operations'](event(body, c.headers))
  ]);
  assert.equal(logout.statusCode, 200); assert.ok([200, 401].includes(earn.statusCode));
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, earn.statusCode === 200 ? 1010 : 1000);
  assert.equal((await c.handlers['admin-operations'](event({ ...body, operationId: 'later' }, c.headers))).statusCode, 401);
});
check('redemption pagination, equal timestamps, full detail and cross-member denial', async () => {
  const envelope = fixture({ members: 2 });
  for (let i = 0; i < 7; i++) redeem(envelope.root, request(`old-${i}`), actor(0), { now: () => '2026-01-01T00:00:00.000Z' });
  const c = await setup({ envelope }), seen = []; let cursor;
  do {
    const result = await c.db.state(actor(0), { limit: 2, cursors: { redemptions: cursor } });
    seen.push(...result.state.redemptions); cursor = result.pages.redemptions.cursor;
    assert.equal(result.summaries.points, 860); assert.equal(result.summaries.pendingRedemptions, 7);
  } while (cursor);
  assert.equal(seen.length, 7); assert.equal(new Set(seen.map(r => r.id)).size, 7);
  const detail = await c.handlers['member-state'](event({}, { authorization: 'Bearer synthetic-0' }, 'GET', { detail: 'redemptions', id: seen[0].id }));
  assert.equal(detail.statusCode, 200); assert.equal(JSON.parse(detail.body).record.stockReserved, true);
  await assert.rejects(c.db.detail(actor(1), 'redemptions', seen[0].id), /history_record_not_found/);
  const invalid = fixture({ members: 1, history: 1 }); delete invalid.root.transactions['TEST-HISTORY-00000000'].date;
  assert.throws(() => planSyntheticImport(invalid), /date needs review/);
});
check('complete succeeds without another debit; reject leaves points unchanged', async () => {
  const envelope = fixture({ members: 1 });
  envelope.root.pendingPurchases['TEST-REJECT'] = { id: 'TEST-REJECT', customerId: 'TEST-MEMBER-0', status: 'pending', amount: 500, date: '2026-01-01T00:00:00.000Z' };
  const c = await setup({ envelope });
  const r = await c.db.financial('redemption', request(), actor(0));
  const complete = { action: 'complete', redemptionId: r.redemptionId, operationId: 'complete' };
  assert.equal((await c.db.financial('redemption', complete, c.admin)).status, 'completed');
  assert.equal((await c.db.financial('redemption', complete, c.admin)).replayed, true);
  await assert.rejects(c.db.financial('redemption', { ...complete, action: 'cancel', operationId: 'late-cancel' }, c.admin), /redemption_already_final/);
  await c.db.financial('admin', { action: 'reject', id: 'TEST-REJECT', operationId: 'reject' }, c.admin);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 980);
  assert.equal((await read(c.store, 'rewards/TEST-REWARD-0')).stock, 99);
  assert.equal((await rows(c.store, 'transactions')).length, 1);
  assert.equal((await c.db.state(actor(0))).summaries.pendingRedemptions, 0);
  assert.equal((await c.db.summary(c.admin)).pendingPurchaseCount, 0);
});

// Deterministic interleavings after snapshot release, before the atomic Commit.
// The interfering client has no shared in-process lock or intercepted transport.
async function interleavedSetup() {
  let beforeCommit;
  const c = await setup({ members: 1 }, { fetcher: async (url, options) => {
    if (url.endsWith(':commit') && beforeCommit) {
      const hook = beforeCommit; beforeCommit = undefined; await hook();
    }
    return fetch(url, options);
  } });
  return { ...c, peer: createStore({ namespace: c.store.namespace }), interfere: hook => { beforeCommit = hook; } };
}
check('optimistic commit verifies read-only writer guard and leaves no partial mutation', async () => {
  const c = await interleavedSetup();
  c.interfere(() => patch(c.peer, 'control/writer', { writesEnabled: false }));
  await assert.rejects(c.db.financial('redemption', request('writer-guard'), actor(0)), /v2_writes_disabled/);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 1000);
  assert.equal((await read(c.store, 'rewards/TEST-REWARD-0')).stock, 100);
  for (const collection of ['transactions', 'redemptions', 'secureOperations']) assert.equal((await rows(c.store, collection)).length, 0);
});
check('optimistic commit verifies admin session revoked after snapshot', async () => {
  const c = await interleavedSetup();
  c.interfere(() => patch(c.peer, `adminSessions/${c.admin.sid}`, { revoked: true }));
  await assert.rejects(c.db.financial('admin', { action: 'counter-sale', operationId: 'session-guard', phone: '0800000000', amount: 1000 }, c.admin), /unauthorized/);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 1000);
  assert.equal((await rows(c.store, 'transactions')).length, 0);
  assert.equal((await rows(c.store, 'secureOperations')).length, 0);
});
check('optimistic commit verifies previously missing read-only guard', async () => {
  const c = await interleavedSetup();
  c.interfere(() => patch(c.peer, 'control/absentGuard', { blocked: true }));
  await assert.rejects(c.store.run(async tx => {
    if (await tx.get('control/absentGuard')) throw Error('synthetic_guard_now_present');
    const customer = await tx.get('customers/TEST-MEMBER-0');
    tx.set('customers/TEST-MEMBER-0', { ...customer, points: 999 });
  }), /synthetic_guard_now_present/);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 1000);
});
check('optimistic delete checks updateTime and rejects the entire stale commit', async () => {
  const c = await interleavedSetup();
  await patch(c.peer, 'control/deleteTarget', { version: 1 });
  c.interfere(() => patch(c.peer, 'control/deleteTarget', { version: 2 }));
  await assert.rejects(c.store.run(async tx => {
    if ((await tx.get('control/deleteTarget')).version !== 1) throw Error('synthetic_delete_target_changed');
    const customer = await tx.get('customers/TEST-MEMBER-0');
    tx.delete('control/deleteTarget'); tx.set('customers/TEST-MEMBER-0', { ...customer, points: 0 });
  }), /synthetic_delete_target_changed/);
  assert.equal((await read(c.store, 'control/deleteTarget')).version, 2);
  assert.equal((await read(c.store, 'customers/TEST-MEMBER-0')).points, 1000);
});
