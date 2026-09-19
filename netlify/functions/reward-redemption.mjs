import { randomUUID } from 'node:crypto';
import { adminAuth, lineAuth, sheetAuth, assertSessionInTransaction } from './lib/auth.mjs';
import { transaction } from './lib/firebase-rest.mjs';
import { operation, memberByLine, record } from './lib/operations.mjs';
import { bodyOf, json, failure, error, key, number } from './lib/http.mjs';
export function redeem(root, body, actor, {
  uuid = randomUUID,
  now = () => new Date().toISOString()
} = {}) {
  const action = body.action || 'request',
    testMode = body.testMode === true;
  if (!['request', 'complete', 'cancel'].includes(action)) throw error(400, 'unknown_action');
  if (actor.role === 'admin') assertSessionInTransaction(root, actor);
  if (testMode) {
    if (actor.role !== 'service') throw error(401, 'unauthorized');
    if (!String(body.redemptionId || '').startsWith('TEST-')) throw error(400, 'test_redemption_id_required');
    if (action === 'request' && (!String(body.memberId || body.customerId || '').startsWith('TEST-') || !String(body.rewardId || '').startsWith('TEST-'))) throw error(400, 'test_data_required');
  } else if (action === 'request' ? actor.role !== 'member' : actor.role !== 'admin') throw error(401, 'unauthorized');
  const operationId = key(body.operationId || (testMode ? body.redemptionId : action !== 'request' ? `${action}-${body.redemptionId}` : ''));
  const payload = {
    action,
    memberId: body.memberId || body.customerId || '',
    rewardId: body.rewardId || '',
    redemptionId: body.redemptionId || '',
    quantity: body.quantity ?? 1,
    testMode
  };
  return operation(root, `redemption:${actor.sub}`, operationId, payload, () => {
    root.redemptions ||= {};
    root.transactions ||= {};
    if (action === 'request') {
      const customer = testMode ? record(root, 'customers', payload.memberId) : memberByLine(root, actor.sub);
      if (!customer || customer.active === false) throw error(404, 'member_invalid');
      if (payload.memberId && payload.memberId !== customer.id) throw error(403, 'member_mismatch');
      const reward = record(root, 'rewards', key(body.rewardId));
      if (reward.active === false || reward.archived || testMode && reward.active !== true) throw error(409, 'reward_inactive');
      const quantity = number(body.quantity ?? 1, {
        min: 1,
        integer: true
      });
      const points = number(number(reward.points, {
        min: 1
      }) * quantity, {
        min: 1
      });
      const before = number(customer.points ?? 0);
      const limited = reward.stock !== '' && reward.stock !== null && reward.stock !== undefined;
      const stock = limited ? number(reward.stock, {
        integer: true
      }) : null;
      if (before < points) throw error(409, 'insufficient_points');
      if (limited && stock < quantity) throw error(409, 'insufficient_stock');
      const redemptionId = testMode ? key(body.redemptionId) : `redeem-${uuid()}`,
        transactionId = `${testMode ? 'TEST-POINTS' : 'redeem-points'}-${uuid()}`,
        date = now();
      if (root.redemptions[redemptionId]) throw error(409, 'redemption_id_exists');
      customer.points = before - points;
      if (limited) reward.stock = stock - quantity;
      // Version the balance: a legacy absolute-stock sync cannot silently restore reserved stock.
      reward.stockVersion = number(reward.stockVersion ?? 0, {
        integer: true
      }) + 1;
      root.redemptions[redemptionId] = {
        id: redemptionId,
        customerId: customer.id,
        memberId: customer.id,
        rewardId: reward.id,
        rewardName: reward.name,
        quantity,
        points,
        pointsUsed: points,
        stockBefore: stock,
        stockAfter: limited ? reward.stock : '',
        stockReserved: limited,
        transactionId,
        date,
        createdAt: date,
        status: 'requested',
        operationId,
        testMode,
        operator: actor.sub
      };
      root.transactions[transactionId] = {
        id: transactionId,
        customerId: customer.id,
        type: 'redeem',
        status: 'confirmed',
        points,
        amount: 0,
        rewardId: reward.id,
        redemptionId,
        date
      };
      return {
        ok: true,
        status: 'requested',
        redemptionId,
        transactionId,
        points,
        totalPoints: customer.points,
        stock: limited ? reward.stock : ''
      };
    }
    const redemption = record(root, 'redemptions', key(body.redemptionId));
    if (testMode && (redemption.testMode !== true || !String(redemption.customerId).startsWith('TEST-') || !String(redemption.rewardId).startsWith('TEST-'))) throw error(400, 'test_redemption_data_required');
    const target = action === 'complete' ? 'completed' : 'cancelled';
    if (redemption.status === target) return {
      ok: true,
      status: target,
      redemptionId: redemption.id
    };
    if (![undefined, 'requested', 'request', 'pending'].includes(redemption.status)) throw error(409, 'redemption_already_final');
    const date = now();
    if (action === 'complete') {
      Object.assign(redemption, {
        status: target,
        approvedAt: date,
        operator: actor.sub
      });
      return {
        ok: true,
        status: target,
        redemptionId: redemption.id
      };
    }
    const customer = record(root, 'customers', redemption.customerId),
      reward = record(root, 'rewards', redemption.rewardId);
    const points = number(redemption.pointsUsed ?? redemption.points, {
        min: 1
      }),
      quantity = number(redemption.quantity ?? 1, {
        min: 1,
        integer: true
      });
    // Legacy records may not have reserved stock. Unknown snapshots require reconciliation.
    if (redemption.stockReserved === undefined && redemption.stockBefore === undefined) throw error(409, 'legacy_redemption_requires_reconciliation');
    const reserved = redemption.stockReserved ?? redemption.stockBefore !== null;
    customer.points = number(number(customer.points ?? 0) + points);
    if (reserved) {
      reward.stock = number(number(reward.stock, {
        integer: true
      }) + quantity, {
        integer: true
      });
      reward.stockVersion = number(reward.stockVersion ?? 0, {
        integer: true
      }) + 1;
    }
    const transactionId = `${testMode ? 'TEST-REFUND' : 'redeem-refund'}-${uuid()}`;
    Object.assign(redemption, {
      status: target,
      cancelledAt: date,
      refundedAt: date,
      refundTransactionId: transactionId,
      operator: actor.sub
    });
    root.transactions[transactionId] = {
      id: transactionId,
      customerId: customer.id,
      type: 'refund',
      status: 'confirmed',
      points,
      amount: 0,
      redemptionId: redemption.id,
      rewardId: reward.id,
      date
    };
    return {
      ok: true,
      status: target,
      redemptionId: redemption.id,
      transactionId,
      totalPoints: customer.points
    };
  });
}
export function createRewardRedemptionHandler({
  tx = transaction,
  authenticateMember = lineAuth,
  authenticateAdmin = adminAuth,
  authenticateService = sheetAuth,
  ...dependencies
} = {}) {
  return async event => {
    try {
      if (event.httpMethod !== 'POST') throw error(405, 'method_not_allowed');
      const body = bodyOf(event);
      const actor = body.testMode === true ? await authenticateService(event) : (body.action || 'request') === 'request' ? await authenticateMember(event) : await authenticateAdmin(event);
      const result = await tx(root => redeem(root, body, actor, dependencies));
      if (body.testMode === true && result.replayed) {
        result.status = (body.action || 'request') === 'request' ? 'duplicate' : `duplicate_${body.action}`;
      }
      return json(200, result);
    } catch (e) {
      return failure(e);
    }
  };
}
export const handler = createRewardRedemptionHandler();
