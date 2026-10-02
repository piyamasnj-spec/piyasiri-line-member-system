import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { createRemoteTransport } from '../netlify/functions/lib/v2/remote.mjs';
import { createStore, encode } from '../netlify/functions/lib/v2/firestore.mjs';
import { createMemberStore } from '../netlify/functions/lib/v2/member-store.mjs';
import { createV2Handlers } from '../netlify/functions/lib/v2/handlers.mjs';
import { fixture, importSynthetic, subject } from '../scripts/v2-synthetic-fixture.mjs';
import { cleanupSynthetic } from '../scripts/v2-cleanup.mjs';
import { remoteEnvironment, oauthResponse, response } from './v2-remote-helpers.mjs';

const check = (name, fn) => test(name, { skip: process.env.FIRESTORE_V2_TESTS !== 'true' }, fn);
const actor = i => ({ role: 'member', sub: subject(i) });
const event = (body = {}, headers = {}, method = 'POST', queryStringParameters = {}) => ({ httpMethod: method, body: JSON.stringify(body), headers: { host: 'synthetic.invalid', origin: 'https://synthetic.invalid', ...headers }, queryStringParameters });
async function harness(fn, options = {}) {
  const oldEnv = { ...process.env }, realFetch = globalThis.fetch, env = remoteEnvironment();
  delete process.env.FIRESTORE_EMULATOR_HOST;
  Object.assign(process.env, env, { ADMIN_SESSION_SECRET: 'synthetic-only-session-secret-'.repeat(3), ADMIN_PASSWORD_SALT: 'synthetic-only-salt-value', SHEET_SYNC_SECRET: 'synthetic-only-service-secret' });
  process.env.ADMIN_PASSWORD_HASH = scryptSync('synthetic-admin-password', process.env.ADMIN_PASSWORD_SALT, 64).toString('hex');
  let loseCommit = false;
  const bridge = async (url, o) => {
    if (url === 'https://oauth2.googleapis.com/token') return oauthResponse();
    const remoteRoot = 'projects/synthetic-v2-test/databases/(default)/documents';
    assert.ok(url.startsWith(`https://firestore.googleapis.com/v1/${remoteRoot}`));
    assert.equal(o.headers.Authorization, 'Bearer synthetic-mock-access');
    const localRoot = 'projects/demo-member-v2/databases/(default)/documents';
    // The only real socket is loopback. No remote Firestore/OAuth request is made.
    const local = url.replace('https://firestore.googleapis.com', 'http://127.0.0.1:8085').replace(remoteRoot, localRoot);
    const result = await realFetch(local, { ...o, headers: { ...o.headers, Authorization: 'Bearer owner' }, ...(o.body ? { body: o.body.replaceAll(remoteRoot, localRoot) } : {}) });
    const text = (await result.text()).replaceAll(localRoot, remoteRoot);
    if (loseCommit && url.endsWith(':commit') && result.ok) { loseCommit = false; throw Error('synthetic-response-loss'); }
    return new Response(text, { status: result.status });
  };
  globalThis.fetch = async (url, o) => {
    if (String(url).startsWith('https://api.line.me/oauth2/v2.1/verify?')) {
      const token = new URL(url).searchParams.get('access_token');
      return /^synthetic-\d+$/.test(token) ? response({ client_id: env.LINE_LOGIN_CHANNEL_ID, expires_in: 600 }) : response({}, 401);
    }
    if (url === 'https://api.line.me/v2/profile') {
      const token = o.headers.Authorization.slice(7); return response({ userId: subject(Number(token.slice(10))) });
    }
    throw Error('all non-mocked external access denied');
  };
  try {
    const transport = createRemoteTransport({ env: process.env, fetcher: bridge });
    const store = createStore({ namespace: transport.namespace, transport });
    await importSynthetic(store, fixture({ members: 25, rewards: 2, ...options }));
    const admin = { role: 'admin', sub: 'admin', sid: randomUUID(), exp: Math.floor(Date.now()/1000) + 1700 };
    await store.run(async tx => { await tx.get(`adminSessions/${admin.sid}`); tx.set(`adminSessions/${admin.sid}`, { exp: admin.exp, revoked: false }); });
    const db = createMemberStore(store), handlers = createV2Handlers(store);
    const read = path => store.run(tx => tx.get(path), { readOnly: true });
    await fn({ store, db, handlers, admin, read, lose: () => { loseCommit = true; }, bridge, env });
  } finally {
    globalThis.fetch = realFetch;
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  }
}

check('remote contract over loopback: response-loss recovery, duplicate and mismatched payload', () => harness(async c => {
  const body = { rewardId: 'TEST-REWARD-0', operationId: 'lost' };
  c.lose(); await assert.rejects(c.db.financial('redemption', body, actor(0)), /v2_commit_outcome_unknown_retry_same_key/);
  const a = await c.db.financial('redemption', body, actor(0)), b = await c.db.financial('redemption', body, actor(0));
  assert.equal(a.replayed, true); assert.equal(a.transactionId, b.transactionId);
  assert.equal((await c.read('customers/TEST-MEMBER-0')).points, 980); assert.equal((await c.read('rewards/TEST-REWARD-0')).stock, 99);
  await assert.rejects(c.db.financial('redemption', { ...body, quantity: 2 }, actor(0)), /idempotency_payload_mismatch/);
  const state = await c.db.state(actor(0)); assert.equal(state.state.transactions.length, 1); assert.equal(state.state.redemptions.length, 1);
}));
check('remote contract over loopback: shared reward 20, no overspend or partial writes', () => harness(async c => {
  await c.store.run(async tx => { const r = await tx.get('rewards/TEST-REWARD-0'); tx.set('rewards/TEST-REWARD-0', { ...r, stock: 2 }); });
  const results = await Promise.allSettled(Array.from({length:20}, (_,i) => c.db.financial('redemption', { rewardId: 'TEST-REWARD-0', operationId: `concurrent-${i}` }, actor(i))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
  assert.equal((await c.read('rewards/TEST-REWARD-0')).stock,0);
  for (let i=0;i<20;i++) assert.equal((await c.read(`customers/TEST-MEMBER-${i}`)).points, results[i].status==='fulfilled'?980:1000);
}));
check('remote handlers enforce auth, host, test identity, V2 cookie isolation, admin earn/revoke', () => harness(async c => {
  assert.equal((await c.handlers['member-state'](event({}, {}, 'GET'))).statusCode,401);
  assert.equal((await c.handlers['member-state'](event({}, { authorization: 'Bearer bad' }, 'GET'))).statusCode,401);
  assert.equal((await c.handlers['member-state'](event({}, { authorization: 'Bearer synthetic-98' }, 'GET'))).statusCode,403);
  assert.equal((await c.handlers['member-state'](event({}, { host: 'wrong.invalid', authorization: 'Bearer synthetic-0' }, 'GET'))).statusCode,403);
  assert.equal((await c.handlers['member-state'](event({}, { origin: '', authorization: 'Bearer synthetic-0' }, 'GET'))).statusCode,200);
  assert.equal((await c.handlers['member-state'](event({}, { origin: 'https://wrong.invalid', authorization: 'Bearer synthetic-0' }, 'GET'))).statusCode,403);
  assert.equal((await c.handlers['reward-redemption'](event({testMode:true}))).statusCode,403);
  assert.equal((await c.handlers['sync-sale-points'](event({}))).statusCode,401);
  assert.throws(()=>createV2Handlers(c.store,{verifyLine:async()=>actor(0)}),/identity_override_denied/);
  const login = await c.handlers['admin-session'](event({ action:'login', password:'synthetic-admin-password' }));
  assert.equal(login.statusCode,200); const cookie=login.headers['Set-Cookie'].split(';')[0]; assert.ok(cookie.startsWith('__Host-member_v2_admin='));
  const body={action:'counter-sale',operationId:'earn',phone:'0800000000',amount:1000};
  assert.equal((await c.handlers['admin-operations'](event(body,{cookie:cookie.replace('member_v2_admin','member_admin')}))).statusCode,401);
  assert.equal((await c.handlers['admin-operations'](event(body,{cookie}))).statusCode,200);
  assert.equal((await c.read('customers/TEST-MEMBER-0')).points,1010);
  assert.equal((await c.handlers['admin-session'](event({action:'logout'},{cookie}))).statusCode,200);
  assert.equal((await c.handlers['admin-operations'](event({...body,operationId:'after'},{cookie}))).statusCode,401);
}));
check('remote handlers register/profile, whitelist, pagination and cross-member denial', () => harness(async c => {
  const headers={authorization:'Bearer synthetic-99'}, body={name:'SYNTHETIC new',phone:'0899999999',area:'',birthday:''};
  const a=await c.handlers['member-profile'](event(body,headers)); assert.equal(a.statusCode,200); assert.equal(JSON.parse(a.body).created,true);
  assert.equal((await c.handlers['member-profile'](event({...body,points:999},headers))).statusCode,400);
  assert.equal((await c.handlers['member-profile'](event({...body,name:'SYNTHETIC edited'},headers))).statusCode,200);
  const first=await c.db.state(actor(0),{limit:1}); assert.equal(first.pages.transactions.hasMore,true);
  const next=await c.db.state(actor(0),{limit:1,cursors:{transactions:first.pages.transactions.cursor}});
  assert.notEqual(first.state.transactions[0].id,next.state.transactions[0].id);
  await assert.rejects(c.db.state(actor(1),{cursors:{transactions:first.pages.transactions.cursor}}),/invalid_history_cursor/);
  const result=await c.db.financial('redemption',{rewardId:'TEST-REWARD-0',operationId:'owned'},actor(0));
  const foreign=await c.handlers['member-state'](event({}, {authorization:'Bearer synthetic-1'},'GET',{detail:'redemptions',id:result.redemptionId}));
  assert.equal(foreign.statusCode,404);
},{history:60}));
check('remote contract over loopback: cancel/complete race remains atomic and replay safe', () => harness(async c => {
  const r=await c.db.financial('redemption',{rewardId:'TEST-REWARD-0',operationId:'race'},actor(0));
  const results=await Promise.allSettled(['cancel','complete'].map(action=>c.db.financial('redemption',{action,redemptionId:r.redemptionId,operationId:action},c.admin)));
  assert.ok(results.some(r=>r.status==='fulfilled'));
  const final=await c.read(`redemptions/${r.redemptionId}`), member=await c.read('customers/TEST-MEMBER-0'), reward=await c.read('rewards/TEST-REWARD-0');
  assert.ok(['cancelled','completed'].includes(final.status));
  assert.equal(member.points,final.status==='cancelled'?1000:980); assert.equal(reward.stock,final.status==='cancelled'?100:99);
}));
check('recursive synthetic cleanup dry-run, missing parent descendants, isolation and zero verification', () => harness(async c => {
  const otherEnv={...c.env,FIRESTORE_V2_NAMESPACE:`synthetic-${randomUUID()}`};
  const t=createRemoteTransport({env:otherEnv,fetcher:c.bridge}), other=createStore({namespace:t.namespace,transport:t});
  await other.run(async tx=>{await tx.get('customers/keep');tx.set('customers/keep',{points:7});});
  await c.store.request(':commit',{writes:[{update:{name:`${c.store.prefix}/orphans/absent/children/leaf`,fields:encode({synthetic:true}).mapValue.fields},currentDocument:{exists:false}}]});
  const dry=await cleanupSynthetic(c.store,{namespace:c.store.namespace}); assert.ok(dry.documents>30); assert.equal(dry.deleted,0);
  assert.equal((await c.read('control/writer')).writesEnabled,true);
  const done=await cleanupSynthetic(c.store,{namespace:c.store.namespace,dryRun:false,confirm:c.store.namespace});
  assert.equal(done.remaining,0); assert.equal(done.deleted,dry.documents);
  assert.equal((await other.run(tx=>tx.get('customers/keep'),{readOnly:true})).points,7);
  await assert.rejects(c.db.financial('redemption',{rewardId:'TEST-REWARD-0',operationId:'after-cleanup'},actor(0)),/v2_writes_disabled/);
}));
