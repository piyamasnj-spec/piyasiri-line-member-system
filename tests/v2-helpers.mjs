import { randomUUID, scryptSync } from 'node:crypto';
import { createStore } from '../netlify/functions/lib/v2/firestore.mjs';
import { createMemberStore } from '../netlify/functions/lib/v2/member-store.mjs';
import { createV2Handlers } from '../netlify/functions/lib/v2/handlers.mjs';
import { lineAuth, cookieName, signSession } from '../netlify/functions/lib/auth.mjs';
import { fixture, importSynthetic, subject } from '../scripts/v2-synthetic-fixture.mjs';
export { fixture, importSynthetic, subject };
export const metricSamples = [];
export const actor = i => ({ role: 'member', sub: subject(i) });
export const event = (body = {}, headers = {}, method = 'POST', queryStringParameters = {}) => ({ httpMethod: method, body: JSON.stringify(body), headers, queryStringParameters });
export function testEnvironment() {
  if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8085') throw Error('explicit loopback emulator required');
  Object.assign(process.env, { FIRESTORE_V2_MODE: 'emulator', FIRESTORE_V2_PROJECT: 'demo-member-v2', CONTEXT: 'test', APP_ORIGIN: 'https://synthetic.invalid', LINE_LOGIN_CHANNEL_ID: 'synthetic-channel', ADMIN_SESSION_SECRET: 'synthetic-session-secret-'.repeat(3), ADMIN_PASSWORD_SALT: 'synthetic-salt-value', SHEET_SYNC_SECRET: 'synthetic-service-only' });
  process.env.ADMIN_PASSWORD_HASH = scryptSync('synthetic-admin-password', process.env.ADMIN_PASSWORD_SALT, 64).toString('hex');
}
export async function setup(options = {}, storeOptions = {}) {
  const metrics = [], store = createStore({ namespace: `synthetic-${randomUUID()}`, onMetric: m => { metrics.push(m); metricSamples.push(m); }, ...storeOptions });
  const envelope = options.envelope || fixture(options);
  await importSynthetic(store, envelope);
  const admin = { role: 'admin', sub: 'admin', sid: randomUUID(), exp: Math.floor(Date.now() / 1000) + 1700 };
  await store.run(async tx => { const path = `adminSessions/${admin.sid}`; await tx.get(path); tx.set(path, { exp: admin.exp, revoked: false }); });
  const verifyLine = e => lineAuth(e, { fetcher: async url => {
    const token = (e.headers.authorization || '').slice(7);
    if (!/^synthetic-\d+$/.test(token)) return { ok: false };
    return { ok: true, json: async () => url.includes('/verify?') ? { client_id: process.env.LINE_LOGIN_CHANNEL_ID, expires_in: 600 } : { userId: subject(Number(token.slice(10))) } };
  } });
  const handlers = createV2Handlers(store, { verifyLine }), db = createMemberStore(store);
  metrics.length = 0;
  return { store, db, metrics, admin, envelope, handlers, headers: { origin: process.env.APP_ORIGIN, cookie: `${cookieName}=${signSession(admin)}` } };
}
export const read = (store, path) => store.run(tx => tx.get(path), { readOnly: true, label: 'verification' });
export async function patch(store, path, fields) { return store.run(async tx => { const old = await tx.get(path); tx.set(path, { ...old, ...fields }); }, { label: 'fixture-setup' }); }
export async function rows(store, collection, filters = [], order = 'id') {
  const all = []; let after;
  do {
    const page = await store.run(tx => tx.query(collection, { filters, order, after, limit: 25 }), { readOnly: true, label: 'verification' });
    all.push(...page); after = page.length === 25 ? { id: page.at(-1).id, date: page.at(-1)[order] } : null;
  } while (after);
  return all;
}
