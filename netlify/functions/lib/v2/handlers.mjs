import { randomUUID, scryptSync } from 'node:crypto';
import { adminAuth, lineAuth, sheetAuth, origin, equal, signSession, sessionCookie } from '../auth.mjs';
import { stableKey } from '../firebase-rest.mjs';
import { error, json, failure, bodyOf } from '../http.mjs';
import { createMemberStore, writer, session } from './member-store.mjs';
import { emulatorTarget } from './firestore.mjs';

// Local-only handler factory. Existing Netlify/v1 entrypoints are deliberately unchanged.
// LINE verification can be injected by tests; defaults still verify channel and identity.
export function createV2Handlers(store, { verifyLine = lineAuth } = {}) {
  const db = createMemberStore(store);
  const verifyAdmin = event => adminAuth(event, { read: async path => ({ value: await store.run(tx => tx.get(path.replace('security/', '')), { readOnly: true, label: 'session-read' }) }) });
  const wrap = fn => async event => { try { emulatorTarget(); return await fn(event); } catch (e) { return failure(e); } };
  const post = event => { if (event.httpMethod !== 'POST') throw error(405, 'method_not_allowed'); return bodyOf(event); };
  return {
    'member-profile': wrap(async e => { const body = post(e); return json(200, await db.profile(body, await verifyLine(e))); }),
    'member-state': wrap(async e => {
      if (e.httpMethod !== 'GET') throw error(405, 'method_not_allowed');
      if (e.queryStringParameters?.admin === 'true') throw error(503, 'v2_admin_read_not_enabled');
      const q = e.queryStringParameters || {}, cursors = {};
      if (q.detail) return json(200, await db.detail(await verifyLine(e), q.detail, q.id));
      for (const collection of ['transactions', 'redemptions', 'pendingPurchases', 'rewards']) if (q[`${collection}Cursor`]) cursors[collection] = q[`${collection}Cursor`];
      return json(200, await db.state(await verifyLine(e), { limit: q.limit === undefined ? 25 : Number(q.limit), cursors }));
    }),
    'reward-redemption': wrap(async e => {
      const body = post(e), actor = body.testMode === true ? sheetAuth(e) : (body.action || 'request') === 'request' ? await verifyLine(e) : await verifyAdmin(e);
      const result = await db.financial('redemption', body, actor);
      if (body.testMode === true && result.replayed) result.status = (body.action || 'request') === 'request' ? 'duplicate' : `duplicate_${body.action}`;
      return json(200, result);
    }),
    'admin-operations': wrap(async e => { const body = post(e); return json(200, await db.financial('admin', body, await verifyAdmin(e))); }),
    'sync-sale-points': wrap(async e => {
      const body = post(e), result = await db.financial('sale', body, sheetAuth(e));
      const status = result.replayed ? ({ confirm: 'duplicate', reverse: 'duplicate_reverse', recalculate: 'duplicate_recalculation' }[body.action || 'confirm']) : result.status;
      return json(200, { ...result, status }); // No external notifications in local synthetic mode.
    }),
    'admin-session': wrap(async e => {
      if (e.httpMethod === 'GET') { await verifyAdmin(e); return json(200, { ok: true }); }
      const body = post(e);
      if (body.action === 'logout') {
        const actor = await verifyAdmin(e);
        await store.run(async tx => { await writer(tx); const s = await session(tx, actor); tx.set(`adminSessions/${actor.sid}`, { ...s, revoked: true }); }, { label: 'logout' });
        return json(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
      }
      if (body.action !== 'login') throw error(400, 'unknown_action');
      origin(e);
      const salt = process.env.ADMIN_PASSWORD_SALT, hash = process.env.ADMIN_PASSWORD_HASH, secret = process.env.ADMIN_SESSION_SECRET;
      if (!salt || salt.length < 16 || !/^[a-f0-9]{128}$/.test(hash || '') || !secret || secret.length < 32) throw error(503, 'admin_password_not_configured');
      if (typeof body.password !== 'string' || body.password.length < 16 || body.password.length > 256) throw error(401, 'unauthorized');
      await store.run(async tx => {
        await writer(tx); const path = `loginAttempts/${stableKey(`admin:${Math.floor(Date.now() / 900_000)}`)}`, old = await tx.get(path);
        if ((old?.count || 0) >= 10) throw error(429, 'login_rate_limited');
        tx.set(path, { count: (old?.count || 0) + 1 });
      }, { label: 'login-budget' });
      if (!equal(scryptSync(body.password, salt, 64).toString('hex'), hash)) throw error(401, 'unauthorized');
      const actor = { role: 'admin', sub: 'admin', sid: randomUUID(), exp: Math.floor(Date.now() / 1000) + 1800 };
      await store.run(async tx => { await writer(tx); const path = `adminSessions/${actor.sid}`; if (await tx.get(path)) throw error(409, 'session_id_exists'); tx.set(path, { exp: actor.exp, revoked: false }); }, { label: 'login-session' });
      return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(signSession(actor)) });
    })
  };
}
