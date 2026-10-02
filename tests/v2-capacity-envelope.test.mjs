import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityDocuments } from '../scripts/v2-capacity-envelope.mjs';
import { redeem } from '../netlify/functions/reward-redemption.mjs';
import { saleOperation } from '../netlify/functions/sync-sale-points.mjs';
import { memberId, lineId } from '../scripts/planned-capacity.mjs';
const options = { members: 5, days: 35, earnPerDay: 7, redeemPerDay: 3 };
const docs = new Map(capacityDocuments(options));
const values = collection => [...docs].filter(([p]) => p.startsWith(collection + '/')).map(([, v]) => v);
const root = Object.fromEntries(['customers', 'rewards', 'transactions', 'redemptions', 'secureOperations'].map(c => [c, Object.fromEntries([...docs].filter(([p]) => p.startsWith(c + '/')).map(([p, v]) => [p.slice(c.length + 1), structuredClone(v)]))]));
test('capacity generator has complete financial records, indexes and retained completion receipts', () => {
  assert.equal(values('transactions').length, 35 * 10); assert.equal(values('redemptions').length, 35 * 3);
  assert.equal(values('secureOperations').length, 35 * 10 + 5 * 3);
  assert.equal(values('bills').length, 35 * 7); assert.equal(values('lineMembers').length, 5); assert.equal(values('phoneMembers').length, 5);
  assert.equal([...docs.keys()].at(-1), 'control/writer');
});
test('capacity generator balances, pending counts, stock versions and summaries agree', () => {
  for (const c of values('customers')) {
    const tx = values('transactions').filter(t => t.customerId === c.id);
    assert.equal(c.points, 10000 + tx.reduce((n, t) => n + (t.type === 'earn' ? t.points : -t.points), 0));
    assert.equal(c.pendingRedemptionCount, values('redemptions').filter(r => r.customerId === c.id && r.status === 'requested').length);
  }
  assert.equal(values('summaryShards').reduce((n, s) => n + s.totalPoints, 0), values('customers').reduce((n, c) => n + c.points, 0));
  for (const r of values('rewards')) { const count = values('redemptions').filter(v => v.rewardId === r.id).length; assert.equal(r.stockVersion, count); assert.equal(r.stock, 100); }
});
test('capacity historical request and earn receipts replay using actual v1 fingerprints', () => {
  const r = values('redemptions')[0];
  const result = redeem(root, { rewardId: r.rewardId, operationId: r.operationId }, { role: 'member', sub: lineId(0) });
  assert.equal(result.replayed, true); assert.equal(result.totalPoints, 10000); // day 0 earns twice, then one redemption
  const earn = values('transactions').find(t => t.type === 'earn');
  const replay = saleOperation(root, { ref: earn.ref, phone: '0800000000', transactionId: earn.id, pointResult: { points: 10, amount: 1000, breakdown: [{ points: 10 }] } });
  assert.equal(replay.replayed, true); assert.equal(replay.totalPoints, 10010);
  assert.equal(root.customers[memberId(0)].points, docs.get(`customers/${memberId(0)}`).points);
});
test('capacity history spans planned dates and summary state is not reset by generator order', () => {
  const dates = values('transactions').map(t => t.date).sort();
  assert.equal(new Date(dates.at(-1)).getTime() >= new Date(dates[0]).getTime() + 34 * 86400000, true);
  const ids = [...capacityDocuments(options)].map(([p]) => p); assert.equal(new Set(ids).size, ids.length);
});
