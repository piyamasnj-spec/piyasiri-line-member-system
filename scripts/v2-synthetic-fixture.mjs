import { stableKey } from '../netlify/functions/lib/firebase-rest.mjs';
import { key } from '../netlify/functions/lib/http.mjs';
import { indexed, shard, emptySummary, pending } from '../netlify/functions/lib/v2/member-store.mjs';
import { encode } from '../netlify/functions/lib/v2/firestore.mjs';

export const subject = i => `U${(i + 1).toString(16).padStart(32, '0')}`;
export const memberId = i => `TEST-MEMBER-${i}`;
export function fixture({ members = 60, rewards = members, history = 0 } = {}) {
  const root = { customers: {}, rewards: {}, transactions: {}, redemptions: {}, secureOperations: {}, pendingPurchases: {}, operationLocks: {} };
  for (let i = 0; i < members; i++) root.customers[memberId(i)] = { id: memberId(i), code: `MB-${String(i + 1).padStart(4, '0')}`, name: `SYNTHETIC ${i}`, phone: `08${String(i).padStart(8, '0')}`, lineUserId: subject(i), points: 1000, totalSpend: 0, area: 'Synthetic', birthday: '', joinedAt: '2026-01-01T00:00:00.000Z' };
  for (let i = 0; i < rewards; i++) root.rewards[`TEST-REWARD-${i}`] = { id: `TEST-REWARD-${i}`, name: `SYNTHETIC reward ${i}`, points: 20, stock: 100, stockVersion: 0, active: true };
  for (let i = 0; i < history; i++) {
    const id = `TEST-HISTORY-${String(i).padStart(8, '0')}`;
    root.transactions[id] = { id, customerId: memberId(i % members), type: 'earn', points: 0, amount: 0, status: 'confirmed', date: new Date(Date.UTC(2023, 0, 1) + (i % 1095) * 86400000).toISOString(), expiresAt: new Date(Date.UTC(2024, 0, 1) + (i % 1095) * 86400000).toISOString() };
  }
  return { synthetic: true, root };
}
// Offline transform only. Does not read RTDB or accept remote export locations.
export function planSyntheticImport(envelope) {
  if (envelope?.synthetic !== true || !envelope.root) throw Error('explicit synthetic fixture required');
  const root = structuredClone(envelope.root), docs = new Map();
  const add = (path, value) => { if (docs.has(path)) throw Error(`ambiguous fixture identity: ${path.split('/')[0]}`); docs.set(path, value); };
  for (let i = 0; i < 32; i++) add(`summaryShards/${i}`, emptySummary());
  let lastCode = Object.keys(root.customers || {}).length;
  for (const [id, c] of Object.entries(root.customers || {})) {
    if (!id.startsWith('TEST-') || c.id !== id || !String(c.name).startsWith('SYNTHETIC')) throw Error('synthetic customer required');
    key(id);
    c.revision = 0; c.pendingRedemptionCount = Object.values(root.redemptions || {}).filter(r => r.customerId === id && pending(r)).length;
    add(`lineMembers/${stableKey(c.lineUserId)}`, { customerId: id }); add(`phoneMembers/${stableKey(c.phone)}`, { customerId: id });
    const s = docs.get(`summaryShards/${shard(id)}`); s.customerCount++; s.totalPoints += c.points;
    lastCode = Math.max(lastCode, Number(/^MB-(\d+)$/.exec(c.code || '')?.[1] || 0));
  }
  for (const collection of ['customers', 'rewards', 'transactions', 'redemptions', 'pendingPurchases', 'secureOperations']) {
    for (const [id, row] of Object.entries(root[collection] || {})) {
      key(id);
      if (collection !== 'secureOperations' && row.id !== id) throw Error('fixture ID mismatch');
      if (['transactions', 'redemptions', 'pendingPurchases'].includes(collection) && !root.customers[row.customerId]) throw Error('fixture dangling customer');
      if (['transactions', 'redemptions', 'pendingPurchases'].includes(collection) && (typeof row.date !== 'string' || !Number.isFinite(Date.parse(row.date)))) throw Error('fixture date needs review before pagination');
      if (collection === 'redemptions' && (!root.rewards[row.rewardId] || !root.transactions[row.transactionId])) throw Error('fixture dangling redemption');
      if (collection === 'rewards' && !id.startsWith('TEST-')) throw Error('synthetic reward required');
      add(`${collection}/${id}`, indexed(collection, row));
      if (collection === 'redemptions') docs.get(`summaryShards/${shard(row.customerId)}`).redemptionCount++;
      if (collection === 'pendingPurchases' && (!row.status || row.status === 'pending')) docs.get(`summaryShards/${shard(row.customerId)}`).pendingPurchaseCount++;
      if (collection === 'transactions' && row.type === 'earn' && (!row.status || row.status === 'confirmed') && row.ref) add(`bills/${stableKey(String(row.ref).trim().toLowerCase())}`, { customerId: row.customerId, activeTransactionId: id, state: 'synced' });
    }
  }
  for (const [id, value] of Object.entries(root.operationLocks || {})) add(`legacyOperationBlocks/${key(id)}`, value);
  add('counters/memberCode', { lastAllocated: lastCode });
  add('control/writer', { schemaVersion: 2, epoch: 'synthetic-v2', writesEnabled: true });
  return docs;
}
export async function importSynthetic(store, envelope) {
  const docs = planSyntheticImport(envelope);
  const entries = [...docs];
  // New isolated namespace only; create-only batches. Never overwrites even synthetic existing rows.
  for (let offset = 0; offset < docs.size; offset += 200) {
    await store.request(':commit', { writes: entries.slice(offset, offset + 200).map(([path, data]) => ({ update: { name: store.name(path), fields: encode(data).mapValue.fields }, currentDocument: { exists: false } })) });
  }
  return { documents: docs.size };
}
