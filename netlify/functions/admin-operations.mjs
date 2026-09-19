import { randomUUID } from 'node:crypto';
import { adminAuth, assertSessionInTransaction } from './lib/auth.mjs';
import { transaction, toArray } from './lib/firebase-rest.mjs';
import { operation, record } from './lib/operations.mjs';
import { json, failure, bodyOf, error, number, key } from './lib/http.mjs';
export function adminOperation(root, body, actor) {
  assertSessionInTransaction(root, actor);
  return operation(root, `admin:${actor.sub}`, key(body.operationId), body, () => {
    const {
        action
      } = body,
      date = new Date().toISOString();
    root.transactions ||= {};
    root.rewards ||= {};
    if (['approve', 'reject'].includes(action)) {
      const pending = record(root, 'pendingPurchases', body.id);
      if (pending.status && pending.status !== 'pending') throw error(409, 'purchase_already_final');
      if (action === 'reject') {
        Object.assign(pending, {
          status: 'rejected',
          reviewedAt: date,
          operator: actor.sub
        });
        return {
          ok: true
        };
      }
      const customer = record(root, 'customers', pending.customerId),
        amount = number(body.amount, {
          min: 1
        });
      const points = Math.floor(amount / 100),
        id = randomUUID();
      customer.points = number(number(customer.points ?? 0) + points);
      customer.totalSpend = number(number(customer.totalSpend ?? 0) + amount);
      root.transactions[id] = {
        id,
        customerId: customer.id,
        type: 'earn',
        status: 'confirmed',
        amount,
        points,
        ref: pending.ref || '',
        proof: pending.proof || '',
        requestedAmount: pending.amount,
        approvedAmount: amount,
        adminNote: String(body.note || '').slice(0, 500),
        date,
        expiresAt: new Date(new Date(date).setMonth(new Date(date).getMonth() + 12)).toISOString()
      };
      Object.assign(pending, {
        status: 'approved',
        reviewedAt: date,
        transactionId: id,
        operator: actor.sub
      });
      return {
        ok: true,
        transactionId: id,
        points,
        totalPoints: customer.points
      };
    }
    if (action === 'counter-sale') {
      const matches = toArray(root.customers).filter(c => c.phone === body.phone);
      if (matches.length !== 1) throw error(409, 'member_not_found_or_ambiguous');
      const customer = record(root, 'customers', matches[0].id),
        amount = number(body.amount, {
          min: 1
        }),
        points = Math.floor(amount / 100),
        id = randomUUID();
      customer.points = number(number(customer.points ?? 0) + points);
      customer.totalSpend = number(number(customer.totalSpend ?? 0) + amount);
      root.transactions[id] = {
        id,
        customerId: customer.id,
        type: 'earn',
        status: 'confirmed',
        amount,
        points,
        date,
        note: 'บันทึกจากหน้าร้านด้วยเบอร์โทร',
        expiresAt: new Date(new Date(date).setMonth(new Date(date).getMonth() + 12)).toISOString()
      };
      return {
        ok: true,
        transactionId: id,
        points,
        totalPoints: customer.points
      };
    }
    if (action === 'reward-add') {
      const id = randomUUID(),
        r = body.reward || {};
      if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 200) throw error(400, 'invalid_reward');
      root.rewards[id] = {
        id,
        name: r.name.trim(),
        points: number(r.points, {
          min: 1
        }),
        stock: r.stock === '' ? '' : number(r.stock, {
          integer: true
        }),
        active: r.active === true,
        imageUrl: validImage(r.imageUrl),
        description: String(r.description || '').slice(0, 2000),
        createdAt: date,
        stockVersion: 0
      };
      return {
        ok: true,
        rewardId: id
      };
    }
    const reward = record(root, 'rewards', body.id);
    if (action === 'reward-image') reward.imageUrl = validImage(body.imageUrl);else if (action === 'reward-toggle') reward.active = reward.active === false;else if (action === 'reward-archive') {
      reward.active = false;
      reward.archived = true;
    } else throw error(400, 'unknown_action');
    reward.updatedAt = date;
    return {
      ok: true
    };
  });
}
function validImage(value) {
  const v = String(value || '').trim();
  if (v && !/^https:\/\//.test(v) && !/^[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp)$/i.test(v) && !/^assets\/rewards\/[a-zA-Z0-9_./-]+$/.test(v)) throw error(400, 'invalid_image_url');
  if (v.length > 2000) throw error(400, 'invalid_image_url');
  return v;
}
export function createAdminOperationsHandler({
  authenticate = adminAuth,
  tx = transaction
} = {}) {
  return async event => {
    try {
      if (event.httpMethod !== 'POST') throw error(405, 'method_not_allowed');
      const actor = await authenticate(event),
        body = bodyOf(event);
      return json(200, await tx(root => adminOperation(root, body, actor)));
    } catch (e) {
      return failure(e);
    }
  };
}
export const handler = createAdminOperationsHandler();
