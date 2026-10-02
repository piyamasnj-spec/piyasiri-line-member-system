import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { testEnvironment, setup, actor, read, rows, fixture } from '../tests/v2-helpers.mjs';
import { memberId } from './v2-synthetic-fixture.mjs';
import { stableKey } from '../netlify/functions/lib/firebase-rest.mjs';
testEnvironment();
const review = process.argv.includes('--contention-review');
const output = new URL(`../../../outputs/${review ? 'v2-local-contention-workload' : 'v2-workload'}.json`, import.meta.url);
const results = [];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] || 0;
function measurements(metrics) {
  const financial = metrics.filter(m => /^(redemption|admin|sale):/.test(m.label));
  assert.ok(financial.every(m => m.docsRead <= 20 && m.docsWritten <= 20 && m.logicalBytes <= 512 * 1024));
  return { financialOperations: financial.length, maxDocsRead: Math.max(0, ...financial.map(m => m.docsRead)), maxDocsWritten: Math.max(0, ...financial.map(m => m.docsWritten)), maxLogicalBytes: Math.max(0, ...financial.map(m => m.logicalBytes)), maxCommitBytes: Math.max(0, ...financial.map(m => m.commitBytes)), financialP50Ms: percentile(financial.map(m => m.elapsedMs), .5), financialP95Ms: percentile(financial.map(m => m.elapsedMs), .95), conflicts: metrics.reduce((n, m) => n + m.conflicts, 0), retries: metrics.reduce((n, m) => n + m.attempts - 1, 0), wireSentBytes: metrics.reduce((n, m) => n + m.wireSentBytes, 0), wireReceivedBytes: metrics.reduce((n, m) => n + m.wireReceivedBytes, 0) };
}
async function persist() { await writeFile(output, JSON.stringify({ localOnly: true, results }, null, 2)); }
for (const [name, count] of [['representative', 5], ['concurrency20', 20], ['burst50', 50]]) {
  const c = await setup({ members: 5000, rewards: 20, history: 1650 });
  const action = i => {
    if (i % 6 === 0 || i % 6 === 1) return c.db.state(actor(i));
    if (i % 6 === 2) return c.db.profile({ name: `SYNTHETIC registration ${i}`, phone: `09${String(i).padStart(8, '0')}`, birthday: '', area: 'Synthetic' }, actor(10000 + i));
    if (i % 6 === 3) return c.db.financial('admin', { action: 'counter-sale', operationId: `earn-${i}`, phone: `08${String(i).padStart(8, '0')}`, amount: 1000 }, c.admin);
    if (i % 6 === 4) return c.db.financial('redemption', { rewardId: 'TEST-REWARD-0', operationId: `redeem-${i}` }, actor(i));
    return c.db.summary(c.admin);
  };
  const times = [], starts = [], completed = [], started = performance.now();
  const outcomes = await Promise.all(Array.from({ length: count }, (_, i) => (async () => { const t = starts[i] = performance.now(); try { await action(i); return { i, ok: true }; } catch (e) { return { i, ok: false, error: e.message }; } finally { completed[i] = performance.now(); times.push(completed[i] - t); } })()));
  const initialMetrics = [...c.metrics];
  const recovery = [];
  for (const o of outcomes.filter(x => !x.ok)) {
    assert.equal(o.error, 'transaction_busy_retry_same_key'); await action(o.i); recovery.push(o.i);
    completed[o.i] = performance.now();
  }
  let earns = 0, debits = 0, registrations = 0;
  for (let i = 0; i < count; i++) {
    if (i % 6 === 3) { earns++; assert.equal((await read(c.store, `customers/${memberId(i)}`)).points, 1010); }
    if (i % 6 === 4) { debits++; assert.equal((await read(c.store, `customers/${memberId(i)}`)).points, 980); }
    if (i % 6 === 2) registrations++;
  }
  const reward = await read(c.store, 'rewards/TEST-REWARD-0'); assert.equal(reward.stock, 100 - debits); assert.equal(reward.stockVersion, debits);
  const summary = await c.db.summary(c.admin); assert.equal(summary.totalPoints, 5000 * 1000 + 10 * earns - 20 * debits); assert.equal(summary.customerCount, 5000 + registrations); assert.equal(summary.redemptionCount, debits);
  for (let i = 0; i < count; i++) if (i % 6 === 3 || i % 6 === 4) {
    const scope = i % 6 === 3 ? 'admin:admin' : `redemption:${actor(i).sub}`, opId = `${i % 6 === 3 ? 'earn' : 'redeem'}-${i}`;
    const receiptPath = `secureOperations/${stableKey(`${scope}:${opId}`)}`, before = await read(c.store, receiptPath);
    await action(i); assert.deepEqual(await read(c.store, receiptPath), before);
    assert.equal((await read(c.store, `customers/${memberId(i)}`)).points, i % 6 === 3 ? 1010 : 980);
  }
  assert.deepEqual(await c.db.summary(c.admin), summary);
  const result = { name, count, members: 5000, retainedTransactions: 1650, firstPassSuccess: outcomes.filter(x => x.ok).length, firstPassFailures: outcomes.filter(x => !x.ok), safeRetries: recovery.length, p50Ms: Math.round(percentile(times, .5)), p95Ms: Math.round(percentile(times, .95)), totalMs: Math.round(performance.now() - started), ...measurements(initialMetrics), integrity: 'PASS' };
  const elapsed = starts.map((start, i) => completed[i] - start);
  Object.assign(result, { endToEndP95Ms: Math.ceil(percentile(elapsed, .95)), endToEndMaxMs: Math.ceil(Math.max(...elapsed)),
    acceptance: percentile(elapsed, .95) <= (count === 5 ? 3000 : 5000) && Math.max(...elapsed) <= 15000 ? 'PASS' : 'FAIL' });
  results.push(result); console.log(JSON.stringify(result)); await persist();
}
{
  const envelope = fixture({ members: 20, rewards: 1 }); envelope.root.rewards['TEST-REWARD-0'].stock = 5;
  const c = await setup({ envelope }), times = [], starts = [], completed = [];
  const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) => (async () => { const t = starts[i] = performance.now(); try { await c.db.financial('redemption', { rewardId: 'TEST-REWARD-0', operationId: `stock-${i}` }, actor(i)); return { i, ok: true }; } catch (e) { return { i, ok: false, error: e.message }; } finally { completed[i] = performance.now(); times.push(completed[i] - t); } })()));
  const metrics = [...c.metrics];
  // Retry only unresolved infrastructure contention, with exactly the same key.
  let safeRetries = 0;
  for (const o of outcomes.filter(x => x.error === 'transaction_busy_retry_same_key')) {
    safeRetries++;
    try { await c.db.financial('redemption', { rewardId: 'TEST-REWARD-0', operationId: `stock-${o.i}` }, actor(o.i)); o.ok = true; delete o.error; }
    catch (e) { o.error = e.message; }
    completed[o.i] = performance.now();
  }
  assert.equal(outcomes.filter(o => o.ok).length, 5); assert.ok(outcomes.filter(o => !o.ok).every(o => o.error === 'insufficient_stock'));
  assert.equal((await rows(c.store, 'transactions')).length, 5); assert.equal((await rows(c.store, 'redemptions')).length, 5);
  const stock = await read(c.store, 'rewards/TEST-REWARD-0'); assert.equal(stock.stock, 0); assert.equal(stock.stockVersion, 5);
  for (const o of outcomes) {
    assert.equal((await read(c.store, `customers/${memberId(o.i)}`)).points, o.ok ? 980 : 1000);
    assert.equal(!!await read(c.store, `secureOperations/${stableKey(`redemption:${actor(o.i).sub}:stock-${o.i}`)}`), o.ok);
  }
  assert.equal((await c.db.summary(c.admin)).totalPoints, 19900);
  const result = { name: 'sameReward20', success: 5, denied: 15, safeRetries, p50Ms: Math.round(percentile(times, .5)), p95Ms: Math.round(percentile(times, .95)), ...measurements(metrics), integrity: 'PASS' };
  const elapsed = starts.map((start, i) => completed[i] - start);
  Object.assign(result, { endToEndP95Ms: Math.ceil(percentile(elapsed, .95)), endToEndMaxMs: Math.ceil(Math.max(...elapsed)),
    acceptance: percentile(elapsed, .95) <= 5000 && Math.max(...elapsed) <= 15000 ? 'PASS' : 'FAIL' });
  results.push(result); console.log(JSON.stringify(result)); await persist();
}
// Same principal documents, 0 versus 32,850 records spread over all 1,095 retention days.
// This is a retention-scope experiment, NOT the entire 602,250-row planning envelope.
const scope = [];
if (!review) {
for (const history of [0, 32850]) {
  const c = await setup({ members: 30, rewards: 1, history });
  await c.db.financial('redemption', { rewardId: 'TEST-REWARD-0', operationId: 'scope-test' }, actor(0));
  const financial = c.metrics.find(m => m.label === 'redemption:request');
  const state = await c.db.state(actor(0), { limit: 5 }); assert.equal(state.summaries.points, 980); assert.ok(state.state.transactions.length <= 5);
  scope.push({ history, retentionDays: history ? 1095 : 0, docsRead: financial.docsRead, docsWritten: financial.docsWritten, logicalBytes: financial.logicalBytes, commitBytes: financial.commitBytes, financialMs: financial.elapsedMs, returnedHistory: state.state.transactions.length });
}
assert.equal(scope[0].docsRead, scope[1].docsRead); assert.equal(scope[0].docsWritten, scope[1].docsWritten); assert.equal(scope[0].logicalBytes, scope[1].logicalBytes);
results.push({ name: 'retentionScope', measurements: scope, integrity: 'PASS', limitation: 'Full 3-year planning envelope not loaded; transaction scope proven by same document set and exact byte equality with representative 3-year history.' });
console.log(JSON.stringify(results.at(-1))); await persist();
}
if (review && results.some(r => r.acceptance !== 'PASS')) process.exitCode = 1;
