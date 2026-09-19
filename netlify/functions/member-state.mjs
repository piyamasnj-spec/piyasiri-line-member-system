import { lineAuth, adminAuth } from './lib/auth.mjs';
import { firebaseRead, toArray } from './lib/firebase-rest.mjs';
import { memberByLine } from './lib/operations.mjs';
import { json, error, failure } from './lib/http.mjs';
export function selectMemberState(root, actor) {
  const names = ['customers', 'transactions', 'pendingPurchases', 'redemptions', 'rewards'];
  if (actor.role === 'admin') return Object.fromEntries(names.map(n => [n, toArray(root[n]).filter(item => n === 'pendingPurchases' ? !item.status || item.status === 'pending' : n === 'rewards' ? !item.archived : true)]));
  const member = memberByLine(root, actor.sub);
  return {
    customers: member ? [member] : [],
    transactions: toArray(root.transactions).filter(t => member && t.customerId === member.id),
    pendingPurchases: toArray(root.pendingPurchases).filter(t => member && t.customerId === member.id),
    redemptions: toArray(root.redemptions).filter(t => member && t.customerId === member.id),
    rewards: toArray(root.rewards).filter(r => r.active !== false && !r.archived)
  };
}
export function createMemberStateHandler({
  authenticate = lineAuth,
  authenticateAdmin = adminAuth,
  read = firebaseRead
} = {}) {
  return async event => {
    try {
      if (event.httpMethod !== 'GET') throw error(405, 'method_not_allowed');
      const actor = event.queryStringParameters?.admin === 'true' ? await authenticateAdmin(event) : await authenticate(event);
      // A single snapshot keeps balances and ledgers consistent; only selectMemberState
      // is serialized, never security/session/operation records from the root.
      const root = (await read('')).value || {};
      return json(200, {
        ok: true,
        state: selectMemberState(root, actor)
      });
    } catch (e) {
      return failure(e);
    }
  };
}
export const handler = createMemberStateHandler();
