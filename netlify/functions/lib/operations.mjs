import { stableKey, toArray } from './firebase-rest.mjs';
import { error, key } from './http.mjs';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function operation(root, scope, operationId, payload, perform) {
  key(operationId);
  const id = stableKey(`${scope}:${operationId}`),
    fingerprint = stableKey(JSON.stringify(canonical(payload)));
  const previous = root.secureOperations?.[id];
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw error(409, 'idempotency_payload_mismatch');
    return {
      ...previous.result,
      replayed: true
    };
  }
  const result = perform();
  root.secureOperations ||= {};
  root.secureOperations[id] = {
    fingerprint,
    result,
    completedAt: new Date().toISOString()
  };
  return result;
}
export function record(root, collection, id) {
  key(id);
  const matches = toArray(root[collection]).filter(x => x.id === id);
  if (matches.length !== 1) throw error(409, `${collection}_not_found_or_ambiguous`);
  if (root[collection][matches[0].firebaseKey].id !== id) throw error(409, `${collection}_identity_requires_reconciliation`);
  return root[collection][matches[0].firebaseKey];
}
export function memberByLine(root, subject) {
  const matches = toArray(root.customers).filter(x => x.lineUserId === subject);
  if (matches.length > 1) throw error(409, 'member_identity_ambiguous');
  if (matches[0] && root.customers[matches[0].firebaseKey].id !== matches[0].id) throw error(409, 'member_identity_requires_reconciliation');
  return matches[0] ? root.customers[matches[0].firebaseKey] : null;
}
