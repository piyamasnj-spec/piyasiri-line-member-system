import { randomUUID } from 'node:crypto';
import { redeem } from '../../reward-redemption.mjs';
import { adminOperation } from '../../admin-operations.mjs';
import { saleOperation } from '../../sync-sale-points.mjs';
import { profileFields } from '../../member-profile.mjs';
import { stableKey } from '../firebase-rest.mjs';
import { error, key, number } from '../http.mjs';
import { bytes } from './firestore.mjs';

export const shard = id => String(parseInt(stableKey(id).slice(0, 8), 16) % 32);
export const emptySummary = () => ({ customerCount: 0, totalPoints: 0, pendingPurchaseCount: 0, redemptionCount: 0 });
export const pending = r => r && [undefined, 'requested', 'request', 'pending'].includes(r.status);
export const indexed = (collection, value) => collection === 'rewards' ? { ...value, visible: value.active !== false && !value.archived } : collection === 'transactions' ? {
  ...value, expiryEligible: value.type === 'earn' && (!value.status || value.status === 'confirmed') && !!value.expiresAt && !value.expiryNotifiedAt
} : value;
export function phoneVariants(value) {
  const p = String(value ?? '').replace(/\D/g, ''), set = new Set([p]);
  if (p.length === 9) set.add(`0${p}`);
  if (p.startsWith('66') && p.length === 11) set.add(`0${p.slice(2)}`);
  if (p.startsWith('0') && p.length === 10) { set.add(p.slice(1)); set.add(`66${p.slice(1)}`); }
  return [...set];
}
export async function writer(tx) {
  const control = await tx.get('control/writer');
  if (!control || control.schemaVersion !== 2 || control.epoch !== 'synthetic-v2' || control.writesEnabled !== true) throw error(503, 'v2_writes_disabled');
}
export async function session(tx, actor) {
  if (actor?.role !== 'admin' || actor.sub !== 'admin' || !actor.sid) throw error(401, 'unauthorized');
  const s = await tx.get(`adminSessions/${key(actor.sid)}`);
  if (!s || s.revoked || s.exp !== actor.exp || s.exp <= Date.now() / 1000) throw error(401, 'unauthorized');
  return s;
}
async function identity(tx, collection, value) {
  const index = await tx.get(`${collection}/${stableKey(value)}`);
  if (index?.blocked) throw error(409, 'member_identity_ambiguous');
  return index?.customerId || null;
}
function receiptId(kind, body, actor) {
  if (kind === 'redemption') return stableKey(`redemption:${actor.sub}:${key(body.operationId || (body.testMode === true ? body.redemptionId : (body.action || 'request') !== 'request' ? `${body.action}-${body.redemptionId}` : ''))}`);
  if (kind === 'admin') return stableKey(`admin:${actor.sub}:${key(body.operationId)}`);
  const action = body.action || 'confirm', ref = String(body.ref || '').trim().toLowerCase();
  if (!ref || ref.length > 160 || !['confirm', 'reverse', 'recalculate'].includes(action)) throw error(400, 'invalid_sale');
  if (action === 'recalculate' && !body.operationId) throw error(400, 'missing_ref_or_operation_id');
  return stableKey(`sale-${action}:${stableKey(action === 'recalculate' ? `${ref}:${body.operationId}` : ref)}`);
}

export function createMemberStore(store) {
  async function financial(kind, body, actor) {
    if (!['redemption', 'admin', 'sale'].includes(kind)) throw error(400, 'unknown_operation');
    if (kind === 'admin' && actor?.role !== 'admin' || kind === 'sale' && actor?.role !== 'service' || kind === 'redemption' && !['admin', 'member', 'service'].includes(actor?.role)) throw error(401, 'unauthorized');
    const receipt = receiptId(kind, body, actor);
    // Reuse the proven v1 pure calculations on a bounded projection, NOT its RTDB transport.
    return store.run(async tx => {
      // Prefetch known paths in the SAME transaction; validation below is unchanged.
      await tx.getMany(['control/writer', `secureOperations/${receipt}`,
        ...(actor.role === 'admin' && actor.sid ? [`adminSessions/${key(actor.sid)}`] : [])]);
      await writer(tx);
      const root = {}, originals = new Map();
      if (actor.role === 'admin') root.security = { adminSessions: { [actor.sid]: await session(tx, actor) } };
      const load = async (collection, id, required = true) => {
        key(id);
        const path = `${collection}/${id}`;
        const value = await tx.get(path); originals.set(path, structuredClone(value));
        if (!value && required) throw error(409, `${collection}_not_found_or_ambiguous`);
        if (value) {
          if (['customers', 'rewards', 'transactions', 'redemptions', 'pendingPurchases'].includes(collection) && value.id !== id) throw error(409, `${collection}_identity_requires_reconciliation`);
          (root[collection] ||= {})[id] = value;
        }
        return value;
      };
      const previous = await load('secureOperations', receipt, false);
      let billPath, bill;
      if (kind === 'sale') {
        const action = body.action || 'confirm', ref = String(body.ref).trim().toLowerCase();
        const lockId = stableKey(`sale-${action}:${action === 'recalculate' ? `${ref}:${body.operationId}` : ref}`.toLowerCase());
        if (await tx.get(`legacyOperationBlocks/${lockId}`)) throw error(409, 'legacy_operation_requires_reconciliation');
        if (!previous) {
          billPath = `bills/${stableKey(ref)}`; bill = await tx.get(billPath);
          if (bill?.blocked) throw error(409, 'ambiguous_bill');
          if (bill?.activeTransactionId) {
            const old = await load('transactions', bill.activeTransactionId);
            if (String(old.ref || '').trim().toLowerCase() !== ref || old.type !== 'earn' || ![undefined, 'confirmed'].includes(old.status)) throw error(409, 'bill_index_requires_review');
            await load('customers', old.customerId);
          } else if (action === 'confirm') {
            const ids = new Set();
            for (const phone of phoneVariants(body.phone)) { const id = await identity(tx, 'phoneMembers', phone); if (id) ids.add(id); }
            if (ids.size !== 1) throw error(409, 'customer_not_found_or_ambiguous');
            await load('customers', [...ids][0]);
          }
          if (body.transactionId) await load('transactions', body.transactionId, false);
        }
      }
      if (!previous && kind === 'redemption') {
        if ((body.action || 'request') === 'request') {
          const id = body.testMode === true ? body.memberId || body.customerId : await identity(tx, 'lineMembers', actor.sub);
          if (!id) throw error(404, 'member_invalid');
          await tx.getMany([`customers/${key(id)}`, `rewards/${key(body.rewardId)}`]);
          const customer = await load('customers', id);
          if (body.testMode !== true && customer.lineUserId !== actor.sub) throw error(409, 'member_identity_requires_reconciliation');
          await load('rewards', body.rewardId);
          if (body.testMode === true) await load('redemptions', body.redemptionId, false);
        } else {
          const r = await load('redemptions', body.redemptionId);
          if (pending(r)) { await load('customers', r.customerId); if (body.action === 'cancel') await load('rewards', r.rewardId); }
        }
      }
      if (!previous && kind === 'admin') {
        if (['approve', 'reject'].includes(body.action)) {
          const p = await load('pendingPurchases', body.id);
          await load('customers', p.customerId);
        } else if (body.action === 'counter-sale') {
          const id = await identity(tx, 'phoneMembers', String(body.phone || ''));
          if (!id) throw error(409, 'member_not_found_or_ambiguous');
          await load('customers', id);
        } else if (body.action !== 'reward-add') await load('rewards', body.id);
      }
      const before = structuredClone(root);
      const result = kind === 'redemption' ? redeem(root, body, actor) : kind === 'admin' ? adminOperation(root, body, actor) : saleOperation(root, body);
      if (previous) return result;
      for (const r of Object.values(root.redemptions || {})) {
        const old = before.redemptions?.[r.id], customer = root.customers?.[r.customerId];
        if (customer && pending(old) !== pending(r)) customer.pendingRedemptionCount = number(number(customer.pendingRedemptionCount ?? 0) + (pending(r) ? 1 : -1));
      }
      const summaryChanges = new Map();
      for (const c of Object.values(root.customers || {})) {
        const old = before.customers[c.id];
        if (JSON.stringify(c) !== JSON.stringify(old)) {
          c.revision = number(old.revision ?? 0, { integer: true }) + 1;
          const sid = shard(c.id), delta = summaryChanges.get(sid) || emptySummary();
          delta.totalPoints += number(c.points) - number(old.points); summaryChanges.set(sid, delta);
        }
      }
      for (const r of Object.values(root.redemptions || {})) if (!before.redemptions?.[r.id]) {
        const sid = shard(r.customerId), delta = summaryChanges.get(sid) || emptySummary(); delta.redemptionCount++; summaryChanges.set(sid, delta);
      }
      for (const p of Object.values(root.pendingPurchases || {})) if ((!before.pendingPurchases[p.id].status || before.pendingPurchases[p.id].status === 'pending') && p.status && p.status !== 'pending') {
        const sid = shard(p.customerId), delta = summaryChanges.get(sid) || emptySummary(); delta.pendingPurchaseCount--; summaryChanges.set(sid, delta);
      }
      const changes = [];
      for (const collection of ['customers', 'rewards', 'transactions', 'redemptions', 'pendingPurchases', 'secureOperations']) for (const [id, value] of Object.entries(root[collection] || {})) {
        if (JSON.stringify(value) !== JSON.stringify(before[collection]?.[id])) changes.push([`${collection}/${id}`, indexed(collection, value)]);
      }
      // Read newly allocated IDs for create preconditions before scheduling any writes.
      await tx.getMany([...changes.filter(([path]) => !originals.has(path)).map(([path]) => path),
        ...[...summaryChanges.keys()].map(sid => `summaryShards/${sid}`)]);
      for (const [path] of changes) if (!originals.has(path) && await tx.get(path)) throw error(409, 'record_id_exists');
      for (const [sid, delta] of summaryChanges) {
        const path = `summaryShards/${sid}`, sum = await tx.get(path);
        if (!sum) throw error(409, 'summary_requires_review');
        for (const field of Object.keys(delta)) sum[field] = number(number(sum[field]) + delta[field]);
        changes.push([path, sum]);
      }
      if (billPath && result.status !== 'duplicate') changes.push([billPath, { customerId: result.customerId, activeTransactionId: (body.action || 'confirm') === 'reverse' ? null : result.transactionId, state: result.status }]);
      for (const [path, value] of changes) tx.set(path, value);
      return result;
    }, { label: `${kind}:${body.action || (kind === 'sale' ? 'confirm' : 'request')}` });
  }
  async function profile(body, actor) {
    if (actor?.role !== 'member') throw error(401, 'unauthorized');
    const fields = profileFields(body), newId = randomUUID();
    return store.run(async tx => {
      await writer(tx);
      const linePath = `lineMembers/${stableKey(actor.sub)}`, phonePath = `phoneMembers/${stableKey(fields.phone)}`;
      const [line, phone] = await tx.getMany([linePath, phonePath]);
      if (line?.blocked || phone?.blocked) throw error(409, 'member_identity_ambiguous');
      if (phone?.customerId && phone.customerId !== line?.customerId) throw error(409, 'phone_already_registered_contact_store');
      const id = line?.customerId || newId, path = `customers/${key(id)}`, customer = await tx.get(path);
      if (!line && customer) throw error(409, 'record_id_exists');
      if (line && (!customer || customer.id !== id || customer.lineUserId !== actor.sub)) throw error(409, 'member_identity_requires_reconciliation');
      if (customer) {
        const oldPhone = `phoneMembers/${stableKey(customer.phone)}`;
        if (oldPhone !== phonePath) {
          const old = await tx.get(oldPhone);
          if (old?.customerId !== id || old.blocked) throw error(409, 'phone_index_requires_review');
          tx.delete(oldPhone);
        }
        Object.assign(customer, fields, { revision: number(customer.revision ?? 0) + 1 });
        tx.set(path, customer); tx.set(phonePath, { customerId: id });
        return { ok: true, customer, created: false };
      }
      const counter = await tx.get('counters/memberCode'), sumPath = `summaryShards/${shard(id)}`, sum = await tx.get(sumPath);
      if (!counter || !sum) throw error(409, 'registration_index_requires_review');
      const next = number(number(counter.lastAllocated, { integer: true }) + 1, { integer: true });
      const created = { id, lineUserId: actor.sub, code: `MB-${String(next).padStart(4, '0')}`, ...fields, points: 0, totalSpend: 0, revision: 0, pendingRedemptionCount: 0, joinedAt: new Date().toISOString() };
      tx.set(path, created); tx.set(linePath, { customerId: id }); tx.set(phonePath, { customerId: id });
      tx.set('counters/memberCode', { lastAllocated: next }); tx.set(sumPath, { ...sum, customerCount: number(sum.customerCount) + 1 });
      return { ok: true, customer: created, created: true };
    }, { label: 'profile' });
  }
  async function state(actor, { limit = 25, cursors = {} } = {}) {
    if (actor?.role !== 'member') throw error(401, 'unauthorized');
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw error(400, 'invalid_page_size');
    return store.run(async tx => {
      const id = await identity(tx, 'lineMembers', actor.sub);
      const customer = id ? await tx.get(`customers/${key(id)}`) : null;
      if (id && (!customer || customer.id !== id || customer.lineUserId !== actor.sub)) throw error(409, 'member_identity_requires_reconciliation');
      const state = { customers: customer ? [customer] : [], transactions: [], redemptions: [], pendingPurchases: [], rewards: [] }, pages = {};
      for (const collection of ['transactions', 'redemptions', 'pendingPurchases', 'rewards']) {
        if (!customer && collection !== 'rewards') continue;
        let after;
        if (cursors[collection]) {
          try {
            if (cursors[collection].length > 1200) throw 0;
            const cursor = JSON.parse(Buffer.from(cursors[collection], 'base64url'));
            if (cursor.owner !== (id || '') || cursor.collection !== collection || typeof cursor.date !== 'string') throw 0;
            key(cursor.id); after = cursor;
          } catch { throw error(400, 'invalid_history_cursor'); }
        }
        const order = collection === 'rewards' ? 'id' : 'date';
        const fields = collection === 'transactions' ? ['id', 'customerId', 'type', 'status', 'points', 'amount', 'date', 'expiresAt', 'rewardId', 'redemptionId'] : undefined;
        const rows = await tx.query(collection, { filters: collection === 'rewards' ? [['visible', 'EQUAL', true]] : [['customerId', 'EQUAL', id]], order, after, limit: limit + 1, fields });
        const page = rows.slice(0, limit), last = page.at(-1);
        state[collection] = page;
        pages[collection] = { hasMore: rows.length > limit, cursor: rows.length > limit ? Buffer.from(JSON.stringify({ owner: id || '', collection, date: last[order], id: last.id })).toString('base64url') : null };
      }
      const expiry = customer ? await tx.query('transactions', { filters: [['customerId', 'EQUAL', id], ['type', 'EQUAL', 'earn']], order: 'expiresAt', direction: 'ASCENDING', limit: 1, fields: ['id', 'expiresAt', 'points'] }) : [];
      const result = { ok: true, state, pages, summaries: { points: customer?.points || 0, pendingRedemptions: customer?.pendingRedemptionCount || 0, nextExpiry: expiry[0] || null }, snapshot: 'single-read-only-transaction' };
      if (bytes(result) > 256 * 1024) throw error(413, 'v2_state_page_budget_exceeded');
      return result;
    }, { readOnly: true, label: 'member-state' });
  }
  async function summary(actor) {
    return store.run(async tx => {
      await session(tx, actor);
      const shards = await tx.getMany(Array.from({ length: 32 }, (_, i) => `summaryShards/${i}`));
      if (shards.some(s => !s)) throw error(409, 'summary_requires_review');
      return shards.reduce((total, s) => {
        for (const field of Object.keys(total)) total[field] = number(total[field] + number(s[field]));
        return total;
      }, emptySummary());
    }, { readOnly: true, label: 'admin-summary' });
  }
  async function detail(actor, collection, recordId) {
    if (actor?.role !== 'member') throw error(401, 'unauthorized');
    if (!['transactions', 'redemptions'].includes(collection)) throw error(400, 'invalid_history_collection');
    key(recordId);
    return store.run(async tx => {
      const id = await identity(tx, 'lineMembers', actor.sub);
      if (!id) throw error(404, 'member_invalid');
      const customer = await tx.get(`customers/${key(id)}`);
      if (!customer || customer.id !== id || customer.lineUserId !== actor.sub) throw error(409, 'member_identity_requires_reconciliation');
      const row = await tx.get(`${collection}/${recordId}`);
      if (!row || row.id !== recordId || row.customerId !== id) throw error(404, 'history_record_not_found');
      return { ok: true, record: row };
    }, { readOnly: true, label: 'history-detail' });
  }
  return { financial, profile, state, summary, detail };
}
