import { randomUUID } from 'node:crypto';
import { lineAuth } from './lib/auth.mjs';
import { transaction, toArray } from './lib/firebase-rest.mjs';
import { memberByLine } from './lib/operations.mjs';
import { json, failure, bodyOf, error } from './lib/http.mjs';
export function profileFields(body) {
  const allowed = ['name', 'phone', 'birthday', 'area'];
  if (Object.keys(body).some(k => !allowed.includes(k))) throw error(400, 'profile_field_not_allowed');
  for (const k of allowed) if (body[k] !== undefined && typeof body[k] !== 'string') throw error(400, 'invalid_profile');
  const fields = Object.fromEntries(allowed.map(k => [k, (body[k] || '').trim()]));
  if (!fields.name || fields.name.length > 150 || !/^0\d{8,9}$/.test(fields.phone) || fields.area.length > 500 || fields.birthday && (!/^\d{4}-\d{2}-\d{2}$/.test(fields.birthday) || !Number.isFinite(Date.parse(fields.birthday)))) throw error(400, 'invalid_profile');
  return fields;
}
export function createMemberProfileHandler({
  authenticate = lineAuth,
  tx = transaction,
  uuid = randomUUID
} = {}) {
  return async event => {
    try {
      if (event.httpMethod !== 'POST') throw error(405, 'method_not_allowed');
      const actor = await authenticate(event),
        fields = profileFields(bodyOf(event)),
        id = uuid();
      const result = await tx(root => {
        const existing = memberByLine(root, actor.sub);
        const phoneMatch = toArray(root.customers).find(c => c.phone === fields.phone && c.lineUserId !== actor.sub);
        // Never claim an existing member by phone number alone.
        if (phoneMatch) throw error(409, 'phone_already_registered_contact_store');
        if (existing) {
          Object.assign(existing, fields);
          return {
            ok: true,
            customer: existing,
            created: false
          };
        }
        root.customers ||= {};
        const members = toArray(root.customers);
        const lastCode = members.reduce((max, item) => Math.max(max, Number(/^MB-(\d+)$/.exec(item.code || '')?.[1] || 0)), members.length);
        if (!Number.isSafeInteger(lastCode + 1)) throw error(409, 'member_code_requires_reconciliation');
        const customer = {
          id,
          lineUserId: actor.sub,
          code: `MB-${String(lastCode + 1).padStart(4, '0')}`,
          ...fields,
          points: 0,
          totalSpend: 0,
          joinedAt: new Date().toISOString()
        };
        root.customers[id] = customer;
        return {
          ok: true,
          customer,
          created: true
        };
      });
      return json(200, result);
    } catch (e) {
      return failure(e);
    }
  };
}
export const handler = createMemberProfileHandler();
