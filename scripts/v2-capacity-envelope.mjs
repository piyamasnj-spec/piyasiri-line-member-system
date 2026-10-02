import { records, memberId, lineId } from './planned-capacity.mjs';
import { indexed, shard, emptySummary } from '../netlify/functions/lib/v2/member-store.mjs';
import { stableKey } from '../netlify/functions/lib/firebase-rest.mjs';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const countFor = (total, index, members) => Math.floor(total / members) + (index < total % members ? 1 : 0);
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const fingerprint = v => stableKey(JSON.stringify(canonical(v)));
const dayDate = (day, offset = 0) => new Date(Date.UTC(2023, 8, 23) + day * 86400000 + offset).toISOString();
const expiry = date => { const d = new Date(date); d.setUTCMonth(d.getUTCMonth() + 12); return d.toISOString(); };

// Reuse the approved v1 sizing generator's IDs/schema and extend it for coherent
// synthetic v2 balances, daily timestamps, receipts, indexes and completed history.
// No real snapshot is read. Every byte is generated here from the planning envelope.
export function* capacityDocuments({ members, days = 1095, earnPerDay, redeemPerDay }) {
  const earns = days * earnPerDay, redeems = days * redeemPerDay, summaries = Array.from({ length: 32 }, emptySummary);
  const completedRedeems = Math.max(0, days - 30) * redeemPerDay;
  let earnIndex = 0, redemptionIndex = 0, receipt, currentRedemption;
  for (const [collection, originalId, original] of records({ members, days, earnPerDay, redeemPerDay })) {
    let id = originalId, row = { ...original };
    if (collection === 'customers') {
      const i = Number(id.slice(-12)) - 1, e = countFor(earns, i, members), r = countFor(redeems, i, members), completed = countFor(completedRedeems, i, members);
      row.points = 10000 + e * 10 - r * 20; row.totalSpend = e * 1000; row.revision = e + r + completed;
      row.pendingRedemptionCount = r - completed; row.joinedAt = dayDate(0);
      const sum = summaries[Number(shard(id))]; sum.customerCount++; sum.totalPoints += row.points; sum.redemptionCount += r;
      yield [`lineMembers/${stableKey(row.lineUserId)}`, { customerId: id }];
      yield [`phoneMembers/${stableKey(row.phone)}`, { customerId: id }];
    } else if (collection === 'rewards') {
      const i = Number(id.split('-').at(-1)); row.stock = 100; row.stockVersion = countFor(redeems, i, 20);
    } else if (collection === 'transactions' && row.type === 'earn') {
      const i = earnIndex++, member = i % members, day = Math.floor(i / earnPerDay);
      row.date = dayDate(day, (i % earnPerDay) * Math.floor(43200000 / earnPerDay)); row.saleDate = row.date.slice(0, 10); row.expiresAt = expiry(row.date);
      const totalPoints = 10000 + countFor(i + 1, member, members) * 10 - countFor(day * redeemPerDay, member, members) * 20;
      const body = { ref: row.ref, phone: `08${String(member).padStart(8, '0')}`, transactionId: id, pointResult: { points: 10, amount: 1000, breakdown: [{ points: 10 }] } };
      receipt = [stableKey(`sale-confirm:${stableKey(row.ref.toLowerCase())}`), { fingerprint: fingerprint(body), result: { ok: true, status: 'synced', customerId: row.customerId, points: 10, totalPoints, transactionId: id }, completedAt: row.date }];
      yield [`bills/${stableKey(row.ref.toLowerCase())}`, { customerId: row.customerId, activeTransactionId: id, state: 'synced' }];
    } else if (collection === 'redemptions') {
      const i = redemptionIndex++, member = i % members, reward = i % 20, day = Math.floor(i / redeemPerDay);
      row.date = dayDate(day, 43200000 + (i % redeemPerDay) * Math.floor(40000000 / redeemPerDay)); row.createdAt = row.date;
      row.stockBefore = 100 + countFor(redeems, reward, 20) - countFor(i, reward, 20); row.stockAfter = row.stockBefore - 1;
      if (i < completedRedeems) { row.status = 'completed'; row.approvedAt = new Date(Date.parse(row.date) + 3600000).toISOString(); row.operator = 'admin'; }
      const totalPoints = 10000 + countFor((day + 1) * earnPerDay, member, members) * 10 - countFor(i + 1, member, members) * 20;
      const payload = { action: 'request', memberId: '', rewardId: row.rewardId, redemptionId: '', quantity: 1, testMode: false };
      receipt = [stableKey(`redemption:${lineId(member)}:${row.operationId}`), { fingerprint: fingerprint(payload), result: { ok: true, status: 'requested', redemptionId: id, transactionId: row.transactionId, points: 20, totalPoints, stock: row.stockAfter }, completedAt: row.date }];
      currentRedemption = row;
    } else if (collection === 'transactions' && row.type === 'redeem') {
      row.date = currentRedemption.date;
    } else if (collection === 'secureOperations') {
      [id, row] = receipt;
      if (currentRedemption?.status === 'completed') {
        const r = currentRedemption, payload = { action: 'complete', memberId: '', rewardId: '', redemptionId: r.id, quantity: 1, testMode: false };
        yield [`secureOperations/${stableKey(`redemption:admin:complete-${r.id}`)}`, { fingerprint: fingerprint(payload), result: { ok: true, status: 'completed', redemptionId: r.id }, completedAt: r.approvedAt }];
      }
      currentRedemption = undefined;
    }
    yield [`${collection}/${id}`, indexed(collection, row)];
  }
  for (let i = 0; i < 32; i++) yield [`summaryShards/${i}`, summaries[i]];
  yield ['counters/memberCode', { lastAllocated: members }];
  // Import this last: a partial namespace must not accept financial operations.
  yield ['control/writer', { schemaVersion: 2, epoch: 'synthetic-v2', writesEnabled: true }];
}

export async function writeEnvelope(options, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const caseName = `${options.members}-${options.earnPerDay === 500 ? 'normal' : 'stress'}`;
  const path = resolve(outputDirectory, `${caseName}.jsonl.gz`), temp = `${path}.partial`;
  const gzip = createGzip({ level: 1 }), file = createWriteStream(temp);
  gzip.pipe(file); const hash = createHash('sha256');
  const collections = {}, started = Date.now(); let documents = 0, jsonlBytes = 0;
  for (const [path, data] of capacityDocuments(options)) {
    const line = JSON.stringify({ path, data }) + '\n'; hash.update(line); jsonlBytes += Buffer.byteLength(line); documents++;
    const collection = path.split('/')[0]; collections[collection] = (collections[collection] || 0) + 1;
    if (!gzip.write(line)) await once(gzip, 'drain');
    if (documents % 250000 === 0) console.log(JSON.stringify({ caseName, generated: documents }));
  }
  gzip.end(); await finished(file); await rename(temp, path);
  const manifest = { synthetic: true, source: 'planned-capacity.mjs records()', caseName, options, documents, jsonlBytes, sha256Uncompressed: hash.digest('hex'), collections, elapsedMs: Date.now() - started, assumptions: 'Opening points=10000 per member; daily earns then redemptions; final stock=100 from sufficient synthetic opening stock; redemptions older than 30 days completed with retained completion receipts; no cancellations in baseline; all server indexes included.' };
  await writeFile(resolve(outputDirectory, `${caseName}.manifest.json`), JSON.stringify(manifest, null, 2));
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { existsSync } = await import('node:fs');
  const dir = new URL('../../emulator-runtime/v2-capacity-data/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  const cases = [];
  for (const members of [5000, 10000]) for (const [earnPerDay, redeemPerDay] of [[500, 50], [1500, 200]]) {
    const name = `${members}-${earnPerDay === 500 ? 'normal' : 'stress'}`;
    if (existsSync(resolve(dir, `${name}.manifest.json`)) && existsSync(resolve(dir, `${name}.jsonl.gz`))) { console.log(`Already generated: ${name}`); continue; }
    const manifest = await writeEnvelope({ members, days: 1095, earnPerDay, redeemPerDay }, dir); cases.push(manifest); console.log(JSON.stringify(manifest));
  }
  await writeFile(new URL('../../../outputs/v2-capacity-generation.json', import.meta.url), JSON.stringify({ cases, directory: dir }, null, 2));
}
