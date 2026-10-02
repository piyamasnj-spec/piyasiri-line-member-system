import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setup, testEnvironment, actor, read, rows, fixture } from '../tests/v2-helpers.mjs';
import { shard } from '../netlify/functions/lib/v2/member-store.mjs';
testEnvironment();
const review = process.argv.includes('--contention-review');
const output = new URL(`../../../outputs/${review ? 'v2-local-contention-diagnostics' : 'v2-capacity-contention'}.json`, import.meta.url);
const results = [];
const p95 = a => [...a].sort((x, y) => x - y)[Math.max(0, Math.ceil(a.length * .95) - 1)] || 0;
for (const mode of ['distinct-rewards', 'same-reward', 'distinct-rewards-unique-shards', 'distinct-rewards-one-shard', 'same-reward-unique-shards']) {
  const sharedReward = mode.startsWith('same-reward');
  const members = mode.endsWith('shards') || mode.endsWith('one-shard') ? 1024 : 20;
  const rpc = [], metrics = [], envelope = fixture({ members, rewards: 20 });
  const groups = new Map();
  for (let i = 0; i < members; i++) {
    const key = shard(`TEST-MEMBER-${i}`);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const selected = mode.endsWith('unique-shards') ? [...groups.values()].slice(0, 20).map(group => group[0])
    : mode.endsWith('one-shard') ? [...groups.values()].find(group => group.length >= 20).slice(0, 20)
    : Array.from({ length: 20 }, (_, i) => i);
  assert.equal(selected.length, 20);
  const selectedShards = selected.map(i => shard(`TEST-MEMBER-${i}`));
  if (mode.endsWith('unique-shards')) assert.equal(new Set(selectedShards).size, 20);
  if (mode.endsWith('one-shard')) assert.equal(new Set(selectedShards).size, 1);
  if (sharedReward) envelope.root.rewards['TEST-REWARD-0'].stock = 5;
  const c = await setup({ envelope }, { onMetric: m => metrics.push(m), fetcher: async (url, options) => {
    const t = performance.now(), request = JSON.parse(options.body), response = await fetch(url, options);
    const data = await response.clone().json();
    rpc.push({ phase: url.split(':').at(-1), elapsedMs: Math.round(performance.now() - t), status: response.status, firestoreStatus: data.error?.status, message: data.error?.message, retryTransaction: !!request.options?.readWrite?.retryTransaction });
    return response;
  } });
  rpc.length = 0; metrics.length = 0;
  const invoke = i => c.db.financial('redemption', { rewardId: `TEST-REWARD-${sharedReward ? 0 : i}`, operationId: `diagnostic-${i}` }, actor(selected[i]));
  const starts = [], completed = [];
  const outcomes = await Promise.all(Array.from({ length: 20 }, (_, i) => {
    starts[i] = performance.now();
    return invoke(i).then(() => ({ i, ok: true }), e => ({ i, ok: false, error: e.message }))
      .finally(() => { completed[i] = performance.now(); });
  }));
  const initialMetrics = [...metrics], initialRpc = [...rpc];
  let recovery = 0;
  for (const outcome of outcomes.filter(o => o.error === 'transaction_busy_retry_same_key')) {
    recovery++;
    try { await invoke(outcome.i); outcome.ok = true; delete outcome.error; } catch (e) { outcome.error = e.message; }
    completed[outcome.i] = performance.now();
  }
  const winners = sharedReward ? 5 : 20;
  assert.equal(outcomes.filter(o => o.ok).length, winners);
  assert.ok(outcomes.filter(o => !o.ok).every(o => o.error === 'insufficient_stock'));
  assert.equal((await rows(c.store, 'transactions')).length, winners);
  assert.equal((await rows(c.store, 'redemptions')).length, winners);
  for (const outcome of outcomes) assert.equal((await read(c.store, `customers/TEST-MEMBER-${selected[outcome.i]}`)).points, outcome.ok ? 980 : 1000);
  for (let i = 0; i < (sharedReward ? 1 : 20); i++) {
    const reward = await read(c.store, `rewards/TEST-REWARD-${i}`);
    assert.equal(reward.stock, sharedReward ? 0 : 99);
    assert.equal(reward.stockVersion, sharedReward ? 5 : 1);
  }
  const summary = await c.db.summary(c.admin);
  assert.equal(summary.totalPoints, members * 1000 - 20 * winners);
  assert.equal(summary.redemptionCount, winners);
  const phases = Object.fromEntries([...new Set(initialRpc.map(r => r.phase))].map(phase => {
    const rows = initialRpc.filter(r => r.phase === phase); return [phase, { calls: rows.length, p95Ms: p95(rows.map(r => r.elapsedMs)), aborted: rows.filter(r => r.firestoreStatus === 'ABORTED').length, versionConflicts: rows.filter(r => r.firestoreStatus === 'FAILED_PRECONDITION').length }];
  }));
  const result = { mode, members, selectedShards, fullEnvelope: false, initialSuccesses: initialMetrics.filter(m => m.ok).length, eventualSuccesses: winners, denials: 20 - winners, externalSameKeyRetries: recovery, p95Ms: p95(initialMetrics.map(m => m.elapsedMs)), conflicts: initialMetrics.reduce((n, m) => n + m.conflicts, 0), phases, abortedMessages: [...new Set(initialRpc.filter(r => r.firestoreStatus === 'ABORTED').map(r => r.message))], beginWithRetryTransaction: initialRpc.filter(r => r.phase === 'beginTransaction' && r.retryTransaction).length, integrity: 'PASS', caveat: 'Diagnostic small dataset only; sequential scenarios are not a production latency SLA. Application/transaction retry policy unchanged.' };
  const elapsed = starts.map((start, i) => completed[i] - start);
  Object.assign(result, { endToEndP95Ms: Math.ceil(p95(elapsed)), endToEndMaxMs: Math.ceil(Math.max(...elapsed)),
    retries: initialMetrics.reduce((sum, m) => sum + m.attempts - 1, 0),
    lockTimeouts: initialRpc.filter(r => /lock timeout/i.test(r.message || '')).length,
    acceptance: p95(elapsed) <= 5000 && Math.max(...elapsed) <= 15000 ? 'PASS' : 'FAIL',
    caveat: 'Local synthetic sample; end-to-end includes external same-key recovery and waiting. Not a managed-service latency SLA.' });
  results.push(result); console.log(JSON.stringify(result));
  await writeFile(output, JSON.stringify(results, null, 2));
}
if (review && results.some(r => r.acceptance !== 'PASS')) process.exitCode = 1;
