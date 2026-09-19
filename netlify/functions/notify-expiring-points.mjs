import { firebaseRead, toArray } from './lib/firebase-rest.mjs';
import { notifyRecord } from './send-line-message.mjs';

// Netlify scheduled functions are not callable through the public function URL.
// Keep config.schedule: removing it would require explicit caller authorization.
export default async function handler() {
  const now = Date.now(),
    end = now + 30 * 24 * 3600_000;
  const transactions = toArray((await firebaseRead('transactions')).value);
  const targets = transactions.filter(t => t.type === 'earn' && (!t.status || t.status === 'confirmed') && !t.expiryNotifiedAt && Date.parse(t.expiresAt) >= now && Date.parse(t.expiresAt) <= end);
  let sent = 0;
  for (const item of targets) {
    const result = await notifyRecord({
      type: 'points_expiring',
      id: item.id
    });
    if (result.ok) sent++;
  }
  return new Response(JSON.stringify({
    ok: true,
    sent
  }), {
    headers: {
      'Content-Type': 'application/json'
    }
  });
}
export const config = {
  schedule: '@daily'
};
