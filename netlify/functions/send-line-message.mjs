import { adminAuth, assertSessionInTransaction } from './lib/auth.mjs';
import { transaction, stableKey, databaseUrl } from './lib/firebase-rest.mjs';
import { record } from './lib/operations.mjs';
import { bodyOf, json, failure, error } from './lib/http.mjs';
export async function pushLineMessage(to, text, retryKey) {
  databaseUrl(); // Staging guard applies even to notification-only requests.
  if (process.env.LINE_NOTIFICATIONS_ENABLED !== 'true') return {
    ok: false,
    status: 'notifications_disabled'
  };
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || !to) throw error(503, 'notification_not_configured');
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(retryKey ? {
        'X-Line-Retry-Key': retryKey
      } : {})
    },
    body: JSON.stringify({
      to,
      messages: [{
        type: 'text',
        text
      }]
    }),
    signal: AbortSignal.timeout(10_000)
  });
  return {
    ok: response.ok || response.status === 409 && !!response.headers.get('x-line-accepted-request-id')
  };
}
export async function notifyRecord(body, {
  tx = transaction,
  push = pushLineMessage,
  actor
} = {}) {
  if (!['approved_points', 'redeem_completed', 'redeem_cancelled', 'points_expiring'].includes(body.type)) throw error(400, 'unknown_notification');
  const hash = stableKey(`${body.type}:${body.id}`),
    retryKey = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const job = await tx(root => {
    if (actor) assertSessionInTransaction(root, actor);
    root.notificationJobs ||= {};
    const prior = root.notificationJobs[hash];
    if (prior?.sent) return {
      sent: true
    };
    // Persist the exact payload: retries must not change after balances change.
    if (prior) return prior;
    const redemption = body.type.startsWith('redeem_');
    const item = record(root, redemption ? 'redemptions' : 'transactions', body.id),
      customer = record(root, 'customers', item.customerId);
    if (body.type === 'redeem_completed' && item.status !== 'completed' || body.type === 'redeem_cancelled' && item.status !== 'cancelled') throw error(409, 'notification_state_mismatch');
    if (!redemption && (item.type !== 'earn' || ![undefined, 'confirmed'].includes(item.status))) throw error(409, 'notification_state_mismatch');
    if (body.type === 'points_expiring' && (!item.expiresAt || item.expiryNotifiedAt)) return {
      sent: true
    };
    const text = body.type === 'approved_points' ? `ร้านปิยสิริเคมีเกษตรเพิ่มคะแนนให้แล้ว +${item.points} คะแนน\nคะแนนรวมปัจจุบัน: ${customer.points}` : body.type === 'points_expiring' ? `แจ้งเตือนแต้มใกล้หมดอายุ ${item.points} แต้ม วันที่ ${item.expiresAt}` : `${body.type === 'redeem_completed' ? 'จัดการคำขอแลกของเรียบร้อยแล้ว' : 'ยกเลิกคำขอแลกและคืนคะแนนแล้ว'}\nรายการ: ${item.rewardName}\nคะแนนรวมปัจจุบัน: ${customer.points}`;
    const next = {
      to: customer.lineUserId || '',
      text,
      retryKey,
      createdAt: new Date().toISOString()
    };
    root.notificationJobs[hash] = next;
    return next;
  });
  if (job.sent) return {
    ok: true,
    replayed: true
  };
  // LINE only retains retry keys for 24h. Never blindly resend an ambiguous old delivery.
  if (Date.now() - Date.parse(job.createdAt) > 23 * 3600_000) throw error(409, 'notification_requires_reconciliation');
  const result = await push(job.to, job.text, job.retryKey);
  if (result.ok) await tx(root => {
    root.notificationJobs[hash].sent = true;
    root.notificationJobs[hash].sentAt = new Date().toISOString();
    if (body.type === 'points_expiring') {
      const t = record(root, 'transactions', body.id);
      t.expiryNotifiedAt = new Date().toISOString();
      t.expiryNotificationStatus = 'sent';
    }
  });
  return result;
}
export function createNotificationHandler({
  authenticate = adminAuth,
  tx = transaction,
  push = pushLineMessage
} = {}) {
  return async event => {
    try {
      if (event.httpMethod !== 'POST') throw error(405, 'method_not_allowed');
      const actor = await authenticate(event);
      return json(200, await notifyRecord(bodyOf(event), {
        tx,
        push,
        actor
      }));
    } catch (e) {
      return failure(e);
    }
  };
}
export const handler = createNotificationHandler();
