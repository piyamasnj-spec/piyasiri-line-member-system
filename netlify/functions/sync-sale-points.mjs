import { randomUUID } from 'node:crypto';
import { transaction, toArray, stableKey } from './lib/firebase-rest.mjs';
import { operation, record } from './lib/operations.mjs';
import { sheetAuth } from './lib/auth.mjs';
import { normalizePhone, validateStoredPointResult } from './lib/points.mjs';
import { json, failure, bodyOf, error, number, key } from './lib/http.mjs';
import { notifyRecord } from './send-line-message.mjs';
function phoneVariants(value) {
  const p = normalizePhone(value),
    set = new Set([p]);
  if (p.length === 9) set.add(`0${p}`);
  if (p.startsWith('66') && p.length === 11) set.add(`0${p.slice(2)}`);
  if (p.startsWith('0') && p.length === 10) {
    set.add(p.slice(1));
    set.add(`66${p.slice(1)}`);
  }
  return set;
}
export function saleOperation(root, body) {
  const action = body.action || 'confirm',
    ref = String(body.ref || '').trim();
  if (!ref || ref.length > 160) throw error(400, 'missing_ref');
  if (!['confirm', 'reverse', 'recalculate'].includes(action)) throw error(400, 'unknown_action');
  const normalized = ref.toLowerCase(),
    operationRef = action === 'recalculate' ? `${normalized}:${body.operationId || ''}` : normalized;
  if (action === 'recalculate' && !body.operationId) throw error(400, 'missing_ref_or_operation_id');
  // Do not retry or reinterpret operations from the old non-atomic implementation.
  const legacy = root.operationLocks?.[stableKey(`sale-${action}:${operationRef}`.toLowerCase())];
  if (legacy) throw error(409, 'legacy_operation_requires_reconciliation');
  return operation(root, `sale-${action}`, stableKey(operationRef), body, () => {
    root.transactions ||= {};
    const existing = toArray(root.transactions).filter(t => t.type === 'earn' && (!t.status || t.status === 'confirmed') && String(t.ref || '').trim().toLowerCase() === normalized);
    if (existing.length > 1) throw error(409, 'ambiguous_bill');
    if (action === 'confirm' && existing.length) return {
      ok: true,
      status: 'duplicate',
      transactionId: existing[0].id
    };
    const pointResult = action === 'reverse' ? null : validateStoredPointResult(body.pointResult);
    let customer, original;
    if (action === 'confirm') {
      const phone = normalizePhone(body.phone);
      if (!phone) throw error(400, 'missing_phone');
      const requested = phoneVariants(phone),
        matches = toArray(root.customers).filter(c => [...requested].some(p => phoneVariants(c.phone).has(p)));
      if (matches.length !== 1) throw error(409, 'customer_not_found_or_ambiguous');
      customer = record(root, 'customers', matches[0].id);
    } else {
      if (!existing.length) throw error(404, 'transaction_not_found');
      original = record(root, 'transactions', existing[0].id);
      customer = record(root, 'customers', original.customerId);
    }
    const originalPoints = original ? number(original.points ?? 0) : 0,
      originalAmount = original ? number(original.amount ?? 0) : 0;
    const points = action === 'reverse' ? originalPoints : number(pointResult.points),
      amount = action === 'reverse' ? originalAmount : number(pointResult.amount ?? 0);
    const delta = action === 'confirm' ? points : action === 'reverse' ? -points : points - originalPoints;
    const next = number(customer.points ?? 0) + delta;
    if (next < 0) throw error(409, 'insufficient_points_for_reversal');
    customer.points = number(next);
    customer.totalSpend = Math.max(0, number(customer.totalSpend ?? 0) + (action === 'confirm' ? amount : action === 'reverse' ? -amount : amount - originalAmount));
    const id = body.transactionId ? key(body.transactionId) : `${action === 'confirm' ? 'sheet' : action === 'reverse' ? 'reverse' : 'recalc'}-${randomUUID()}`,
      date = new Date().toISOString();
    if (root.transactions[id]) throw error(409, 'transaction_id_exists');
    const entry = {
      id,
      customerId: customer.id,
      type: action === 'reverse' ? 'sale_reversal' : 'earn',
      status: 'confirmed',
      points,
      amount,
      ref,
      source: 'google-sheet',
      date,
      operator: String(body.operator || 'google-sheet')
    };
    if (pointResult) {
      entry.pointBreakdown = pointResult.breakdown;
      entry.alerts = pointResult.alerts || [];
    }
    if (action === 'confirm') {
      entry.note = body.note || 'บันทึกจาก Google Sheet ระบบร้าน';
      entry.saleDate = body.saleDate || '';
      entry.expiresAt = new Date(new Date(date).setMonth(new Date(date).getMonth() + 12)).toISOString();
    }
    if (original) {
      original.status = action === 'reverse' ? 'reversed' : 'revised';
      if (action === 'reverse') {
        original.reversedAt = date;
        original.reversalTransactionId = id;
        entry.originalTransactionId = original.id;
      } else {
        original.revisedAt = date;
        original.replacementTransactionId = id;
        entry.previousTransactionId = original.id;
      }
    }
    root.transactions[id] = entry;
    return {
      ok: true,
      status: action === 'confirm' ? 'synced' : action === 'reverse' ? 'reversed' : 'recalculated',
      customerId: customer.id,
      points,
      totalPoints: customer.points,
      transactionId: id,
      ...(original ? {
        originalTransactionId: original.id
      } : {}),
      ...(action === 'recalculate' ? {
        deltaPoints: delta
      } : {})
    };
  });
}
export function createSaleHandler({
  authenticate = sheetAuth,
  tx = transaction,
  notify = notifyRecord
} = {}) {
  return async event => {
    try {
      if (event.httpMethod === 'GET') return json(200, {
        ok: true,
        service: 'sync-sale-points',
        version: 3
      });
      if (event.httpMethod !== 'POST') throw error(405, 'method_not_allowed');
      await authenticate(event);
      const body = bodyOf(event);
      const result = await tx(root => saleOperation(root, body));
      // Notification failure cannot mark a committed financial operation failed.
      if ((body.action || 'confirm') === 'confirm' && result.status === 'synced') {
        try {
          result.notification = await notify({
            type: 'approved_points',
            id: result.transactionId
          }, {
            tx
          });
        } catch {
          result.notification = {
            ok: false
          };
        }
      }
      // Preserve the existing service-facing duplicate status vocabulary.
      const status = result.replayed ? ({confirm:'duplicate',reverse:'duplicate_reverse',recalculate:'duplicate_recalculation'}[body.action || 'confirm']) : result.status;
      return json(200, { ...result, status });
    } catch (e) {
      return failure(e);
    }
  };
}
export const handler = createSaleHandler();
