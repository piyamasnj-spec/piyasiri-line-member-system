// Offline evidence audit and shard analysis; no database, network, archive generation or benchmark.
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { shard } from '../netlify/functions/lib/v2/member-store.mjs';

const outputs = new URL('../../../outputs/', import.meta.url);
const archives = new URL('../../emulator-runtime/v2-capacity-data/', import.meta.url);
const json = async url => JSON.parse(await readFile(url, 'utf8'));
const verification = await json(new URL('v2-capacity-archive-verification.json', outputs));
const workload = await json(new URL('v2-workload.json', outputs));
const contention = await json(new URL('v2-capacity-contention.json', outputs));
const checks = [];
function check(name, fn) { fn(); checks.push({ name, status: 'PASS' }); }
for (const name of ['5000-normal', '5000-stress', '10000-normal', '10000-stress']) {
  const manifest = await json(new URL(`${name}.manifest.json`, archives));
  const file = await stat(new URL(`${name}.jsonl.gz`, archives));
  check(`existing manifest/report consistency: ${name}`, () => {
    const result = verification.find(row => row.name === name);
    assert.equal(manifest.synthetic, true);
    assert.equal(manifest.options.days, 1095);
    assert.ok(file.size > 0);
    assert.equal(result.gzipHashCountsAndBalances, 'PASS');
    assert.equal(result.documents, manifest.documents);
    assert.equal(result.jsonlBytes, manifest.jsonlBytes);
    assert.deepEqual(result.collections, manifest.collections);
  });
}
check('recorded retention scope does not grow', () => {
  const [empty, retained] = workload.results.find(row => row.name === 'retentionScope').measurements;
  assert.equal(empty.history, 0); assert.equal(retained.history, 32850);
  for (const key of ['docsRead', 'docsWritten', 'logicalBytes', 'commitBytes']) assert.equal(empty[key], retained[key]);
  assert.ok(retained.docsRead <= 20 && retained.logicalBytes <= 512 * 1024);
});
check('recorded workload integrity covers required cases', () => {
  for (const name of ['representative', 'concurrency20', 'burst50', 'sameReward20', 'retentionScope']) {
    assert.equal(workload.results.find(row => row.name === name)?.integrity, 'PASS');
  }
});
check('recorded contention integrity covers both shared resources', () => {
  assert.equal(contention.length, 5);
  for (const row of contention) assert.equal(row.integrity, 'PASS');
  assert.ok(contention.find(row => row.mode === 'distinct-rewards-one-shard').conflicts > 0);
  assert.ok(contention.find(row => row.mode === 'same-reward-unique-shards').conflicts > 0);
});
const regression = await readFile(new URL('v2-retest-regressions-20261001.txt', outputs), 'utf8');
check('historical regression report complete', () => {
  assert.match(regression, /pass 84/); assert.match(regression, /fail 0/); assert.match(regression, /skipped 0/);
});

const populations = [5000, 10000].map(members => {
  const counts = Array(32).fill(0);
  for (let i = 0; i < members; i++) counts[Number(shard(`TEST-MEMBER-${i}`))]++;
  const pairCollision = counts.reduce((sum, count) => sum + count * (count - 1), 0) / (members * (members - 1));
  return { members, counts, min: Math.min(...counts), max: Math.max(...counts),
    sameShardPairProbability: pairCollision,
    workloads: [5, 20, 50].map(concurrency => ({ concurrency,
      expectedCollidingPairs: concurrency * (concurrency - 1) / 2 * pairCollision })) };
});
check('actual shard function distributes synthetic population across 32 shards', () => {
  for (const row of populations) {
    assert.equal(row.counts.reduce((sum, count) => sum + count, 0), row.members);
    assert.ok(row.min > 0);
  }
});
const result = {
  scope: 'Offline audit of existing results plus new deterministic shard analysis; NOT new integration or latency evidence',
  checks, auditPassed: checks.length, cloudOperations: 0, costUSD: 0,
  populations,
  assumptions: 'Uniform sampling of distinct synthetic member IDs; colliding pairs are shared-document candidates, not failed transactions or measured retry probabilities. Same-member/hot-reward skew is not uniform.',
  historicalRegressionPass: 84, capacityStatus: 'BLOCKED',
  limitation: 'Archives were not rehashed; prior streaming verification reused. Availability/managed-service latency unresolved; no full-envelope database loaded.'
};
await writeFile(new URL('v2-free-capacity-audit.json', outputs), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
