import { randomUUID, scryptSync } from 'node:crypto';
import { adminAuth, lineAuth, sheetAuth, origin, equal, signSession, sessionCookie } from '../auth.mjs';
import { stableKey } from '../firebase-rest.mjs';
import { error, json, failure, bodyOf, header } from '../http.mjs';
import { createMemberStore, writer, session } from './member-store.mjs';
import { emulatorTarget } from './firestore.mjs';
import { remoteConfig } from './remote.mjs';

// Shared V2 handler factory. Existing Netlify/v1 entrypoints remain unchanged.
// Identity injection is emulator-only; remote always verifies LINE and the test-subject list.
export function createV2Handlers(store, { verifyLine = lineAuth } = {}) {
  if (store.remote && verifyLine !== lineAuth) throw error(503, 'v2_identity_override_denied');
  const memberAuth = async e => {
    const actor = await verifyLine(e);
    if (store.remote && !remoteConfig().subjects.includes(actor.sub)) throw error(403, 'v2_test_identity_required');
    return actor;
  };
  const db = createMemberStore(store);
  const verifyAdmin = event => adminAuth(event, { read: async path => ({ value: await store.run(tx => tx.get(path.replace('security/', '')), { readOnly: true, label: 'session-read' }) }) });
  const wrap = fn => async event => { try {
    if (store.remote) {
      store.assertTarget();
      const config = remoteConfig();
      const requestOrigin = header(event, 'origin');
      // Same-origin browser GETs can omit Origin; authentication still applies.
      if (header(event, 'host') !== new URL(config.origin).host ||
          (requestOrigin && requestOrigin !== config.origin) || (event.httpMethod !== 'GET' && requestOrigin !== config.origin)) throw error(403, 'origin_denied');
      // A V1 cookie must never authenticate or be overwritten by a V2 endpoint.
      const cookies = header(event, 'cookie').split(';').map(s => s.trim()).filter(s => s.startsWith('__Host-member_v2_admin='));
      if (cookies.length > 1) throw error(401, 'unauthorized');
      event = { ...event, headers: Object.fromEntries(Object.entries(event.headers || {}).filter(([k]) => k.toLowerCase() !== 'cookie')) };
      event.headers.cookie = (cookies[0] || '').replace('__Host-member_v2_admin=', '__Host-member_admin=');
      if (event.httpMethod === 'POST' && bodyOf(event).testMode === true) throw error(403, 'v2_test_mode_bypass_denied');
    } else emulatorTarget();
    const result = await fn(event);
    if (store.remote && result.headers?.['Set-Cookie']) result.headers['Set-Cookie'] = result.headers['Set-Cookie'].replace('__Host-member_admin=', '__Host-member_v2_admin=');
    return result;
  } catch (e) { return failure(e); } };
  const post = event => { if (event.httpMethod !== 'POST') throw error(405, 'method_not_allowed'); return bodyOf(event); };
  return {
    'member-profile': wrap(async e => { const body = post(e); return json(200, await db.profile(body, await memberAuth(e))); }),
    'member-state': wrap(async e => {
      if (e.httpMethod !== 'GET') throw error(405, 'method_not_allowed');
      if (e.queryStringParameters?.admin === 'true') throw error(503, 'v2_admin_read_not_enabled');
      const q = e.queryStringParameters || {}, cursors = {};
      if (q.detail) return json(200, await db.detail(await memberAuth(e), q.detail, q.id));
      for (const collection of ['transactions', 'redemptions', 'pendingPurchases', 'rewards']) if (q[`${collection}Cursor`]) cursors[collection] = q[`${collection}Cursor`];
      return json(200, await db.state(await memberAuth(e), { limit: q.limit === undefined ? 25 : Number(q.limit), cursors }));
    }),
    'reward-redemption': wrap(async e => {
      const body = post(e), actor = body.testMode === true ? sheetAuth(e) : (body.action || 'request') === 'request' ? await memberAuth(e) : await verifyAdmin(e);
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
