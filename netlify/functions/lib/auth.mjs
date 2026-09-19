import { createHmac, timingSafeEqual, randomUUID, scryptSync } from 'node:crypto';
import { transaction, firebaseRead, stableKey } from './firebase-rest.mjs';
import { error, header } from './http.mjs';
export const cookieName = '__Host-member_admin';
const ttl = 1800;
export function equal(a, b) {
  const x = Buffer.from(String(a)),
    y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
function sessionSecret() {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (!s || s.length < 32) throw error(503, 'admin_session_not_configured');
  return s;
}
export function origin(event) {
  if (!process.env.APP_ORIGIN || header(event, 'origin') !== process.env.APP_ORIGIN) throw error(403, 'origin_denied');
}
export function sheetAuth(event) {
  if (!process.env.SHEET_SYNC_SECRET || !equal(header(event, 'x-sheet-sync-secret'), process.env.SHEET_SYNC_SECRET)) throw error(401, 'unauthorized');
  return {
    role: 'service',
    sub: 'sheet'
  };
}
export function signSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${createHmac('sha256', sessionSecret()).update(encoded).digest('base64url')}`;
}
export function decodeSession(token) {
  const [encoded, signature, ...extra] = String(token).split('.');
  if (!encoded || !signature || extra.length || !equal(signature, createHmac('sha256', sessionSecret()).update(encoded).digest('base64url'))) throw error(401, 'unauthorized');
  let p;
  try {
    p = JSON.parse(Buffer.from(encoded, 'base64url').toString());
  } catch {
    throw error(401, 'unauthorized');
  }
  const now = Math.floor(Date.now() / 1000);
  if (p.role !== 'admin' || p.sub !== 'admin' || !/^[a-f0-9-]{36}$/.test(p.sid) || !Number.isInteger(p.exp) || p.exp <= now || p.exp > now + ttl) throw error(401, 'unauthorized');
  return p;
}
export async function adminAuth(event, {
  read = firebaseRead,
  mutating = event.httpMethod !== 'GET'
} = {}) {
  if (mutating) origin(event);
  const cookie = header(event, 'cookie').split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`));
  if (!cookie) throw error(401, 'unauthorized');
  const p = decodeSession(cookie.slice(cookieName.length + 1));
  const session = (await read(`security/adminSessions/${p.sid}`)).value;
  if (!session || session.revoked || session.exp !== p.exp) throw error(401, 'unauthorized');
  return p;
}
export function assertSessionInTransaction(root, p) {
  const session = root.security?.adminSessions?.[p.sid];
  if (p.role !== 'admin' || !session || session.revoked || session.exp <= Date.now() / 1000) throw error(401, 'unauthorized');
}
export function sessionCookie(token, maxAge = ttl) {
  return `${cookieName}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
export async function login(event, password, {
  tx = transaction
} = {}) {
  origin(event);
  sessionSecret();
  const salt = process.env.ADMIN_PASSWORD_SALT,
    expected = process.env.ADMIN_PASSWORD_HASH;
  if (!salt || salt.length < 16 || !/^[a-f0-9]{128}$/.test(expected || '')) throw error(503, 'admin_password_not_configured');
  if (typeof password !== 'string' || password.length < 16 || password.length > 256) throw error(401, 'unauthorized');
  // Global distributed attempt budget: client-supplied IP headers cannot evade it.
  const bucket = stableKey(`admin:${Math.floor(Date.now() / 900_000)}`);
  await tx(root => {
    root.security ||= {};
    root.security.loginAttempts ||= {};
    const n = root.security.loginAttempts[bucket] || 0;
    if (n >= 10) throw error(429, 'login_rate_limited');
    root.security.loginAttempts = {
      [bucket]: n + 1
    };
  });
  if (!equal(scryptSync(password, salt, 64).toString('hex'), expected)) throw error(401, 'unauthorized');
  const p = {
    role: 'admin',
    sub: 'admin',
    sid: randomUUID(),
    exp: Math.floor(Date.now() / 1000) + ttl
  };
  await tx(root => {
    root.security.adminSessions ||= {};
    for (const [id, s] of Object.entries(root.security.adminSessions)) if (s.exp < Date.now() / 1000) delete root.security.adminSessions[id];
    root.security.adminSessions[p.sid] = {
      exp: p.exp,
      revoked: false
    };
  });
  return signSession(p);
}
export async function lineAuth(event, {
  fetcher = fetch
} = {}) {
  const token = header(event, 'authorization').match(/^Bearer ([^\s]+)$/)?.[1];
  if (!token || token.length > 4096) throw error(401, 'invalid_line_identity');
  const channel = process.env.LINE_LOGIN_CHANNEL_ID;
  if (!channel) throw error(503, 'line_channel_not_configured');
  const verified = await fetcher(`https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(10_000)
  });
  if (!verified.ok) throw error(401, 'invalid_line_identity');
  const claims = await verified.json();
  if (claims.client_id !== channel || !(claims.expires_in > 0)) throw error(401, 'invalid_line_identity');
  const profile = await fetcher('https://api.line.me/v2/profile', {
    headers: {
      Authorization: `Bearer ${token}`
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!profile.ok) throw error(401, 'invalid_line_identity');
  const user = await profile.json();
  if (!/^U[a-f0-9]{32}$/.test(user.userId || '')) throw error(401, 'invalid_line_identity');
  return {
    role: 'member',
    sub: user.userId
  };
}
