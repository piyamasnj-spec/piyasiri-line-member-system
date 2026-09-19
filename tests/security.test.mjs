import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { adminAuth, login, signSession, sessionCookie, cookieName, lineAuth } from '../netlify/functions/lib/auth.mjs';
import { createAdminOperationsHandler } from '../netlify/functions/admin-operations.mjs';
import { createMemberProfileHandler } from '../netlify/functions/member-profile.mjs';
import { createAdminSessionHandler } from '../netlify/functions/admin-session.mjs';
import { selectMemberState } from '../netlify/functions/member-state.mjs';
import { databaseUrl, createTransaction } from '../netlify/functions/lib/firebase-rest.mjs';
import { fixture, admin, actor, event } from './helpers.mjs';
process.env.APP_ORIGIN = 'https://staging.example';
process.env.ADMIN_SESSION_SECRET = 'test-session-key-'.repeat(4);
const headers = () => ({
  origin: process.env.APP_ORIGIN,
  cookie: `${cookieName}=${signSession(admin)}`
});
test('admin unauthorized, forged session and cross-origin denied before mutation', async () => {
  const f = fixture(),
    h = createAdminOperationsHandler({
      tx: f.tx,
      authenticate: e => adminAuth(e, {
        read: f.read
      })
    }),
    before = f.state;
  for (const hdr of [{
    origin: process.env.APP_ORIGIN
  }, {
    ...headers(),
    cookie: `${cookieName}=forged`
  }, {
    ...headers(),
    origin: 'https://evil.example'
  }]) assert.ok((await h(event({
    action: 'reward-add',
    operationId: 'x'
  }, hdr))).statusCode >= 400);
  assert.deepEqual(f.state, before);
});
test('authorized admin operation passes and preserves unrelated state', async () => {
  const f = fixture(),
    h = createAdminOperationsHandler({
      tx: f.tx,
      authenticate: e => adminAuth(e, {
        read: f.read
      })
    });
  assert.equal((await h(event({
    action: 'reward-toggle',
    id: 'r',
    operationId: 'toggle'
  }, headers()))).statusCode, 200);
  assert.equal(f.state.rewards.r.active, false);
});
test('revoked and expired sessions denied', async () => {
  const f = fixture();
  await f.tx(root => {
    root.security.adminSessions[admin.sid].revoked = true;
  });
  await assert.rejects(adminAuth(event({}, headers()), {
    read: f.read
  }), {
    statusCode: 401
  });
  await assert.rejects(adminAuth(event({}, {
    ...headers(),
    cookie: `${cookieName}=${signSession({
      ...admin,
      exp: 1
    })}`
  }), {
    read: f.read
  }), {
    statusCode: 401
  });
});
test('logout/session revocation during operation is checked inside transaction', async () => {
  const f = fixture(),
    h = createAdminOperationsHandler({
      tx: f.tx,
      authenticate: async () => admin
    });
  await f.tx(root => {
    root.security.adminSessions[admin.sid].revoked = true;
  });
  assert.equal((await h(event({
    action: 'reward-toggle',
    id: 'r',
    operationId: 'x'
  }))).statusCode, 401);
});
test('server login verifies hash and issues secure cookie; distributed rate limit survives requests', async () => {
  const f = fixture();
  process.env.ADMIN_PASSWORD_SALT = 'fixture-salt-not-a-secret';
  process.env.ADMIN_PASSWORD_HASH = scryptSync('fixture-new-password', process.env.ADMIN_PASSWORD_SALT, 64).toString('hex');
  const e = event({}, {
    origin: process.env.APP_ORIGIN
  });
  await assert.rejects(login(e, 'wrong-fixture-password', {
    tx: f.tx
  }), {
    statusCode: 401
  });
  const token = await login(e, 'fixture-new-password', {
    tx: f.tx
  });
  const cookie = sessionCookie(token);
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.ok(await adminAuth(event({}, {
    ...e.headers,
    cookie
  }), {
    read: f.read
  }));
  for (let i = 0; i < 8; i++) await assert.rejects(login(e, 'wrong-fixture-password', {
    tx: f.tx
  }), {
    statusCode: 401
  });
  await assert.rejects(login(e, 'fixture-new-password', {
    tx: f.tx
  }), {
    statusCode: 429
  });
});
test('LINE verifies token audience, expiry and trusted profile', async () => {
  process.env.LINE_LOGIN_CHANNEL_ID = 'fixture-channel';
  const e = event({}, {
    authorization: 'Bearer fake'
  });
  for (const claims of [{
    client_id: 'wrong',
    expires_in: 300
  }, {
    client_id: 'fixture-channel',
    expires_in: 0
  }]) await assert.rejects(lineAuth(e, {
    fetcher: async () => ({
      ok: true,
      json: async () => claims
    })
  }), {
    statusCode: 401
  });
  await assert.rejects(lineAuth(e, {
    fetcher: async () => ({
      ok: false
    })
  }), {
    statusCode: 401
  });
  const valid = await lineAuth(e, {
    fetcher: async url => ({
      ok: true,
      json: async () => url.includes('verify') ? {
        client_id: 'fixture-channel',
        expires_in: 300
      } : {
        userId: actor.sub
      }
    })
  });
  assert.equal(valid.sub, actor.sub);
});
test('profile whitelist refuses points/id/identity injection and phone takeover', async () => {
  const f = fixture(),
    h = createMemberProfileHandler({
      tx: f.tx,
      authenticate: async () => actor
    });
  const profile = {
    name: 'Fixture',
    phone: '0812345678',
    birthday: '',
    area: ''
  };
  for (const field of ['points', 'id', 'lineUserId', 'totalSpend']) assert.equal((await h(event({
    ...profile,
    [field]: 'attacker'
  }))).statusCode, 400);
  const foreign = createMemberProfileHandler({
    tx: f.tx,
    authenticate: async () => ({
      role: 'member',
      sub: 'another'
    })
  });
  assert.equal((await foreign(event(profile))).statusCode, 409);
  assert.equal(f.state.customers.m.points, 10);
});
test('profile updates preserve balances and registration retries create one member', async () => {
  const f = fixture(),
    h = createMemberProfileHandler({
      tx: f.tx,
      authenticate: async () => actor
    });
  assert.equal((await h(event({
    name: 'Updated',
    phone: '0812345678'
  }))).statusCode, 200);
  assert.equal(f.state.customers.m.points, 10);
  const fresh = createMemberProfileHandler({
    tx: f.tx,
    authenticate: async () => ({
      role: 'member',
      sub: 'new'
    })
  });
  await Promise.all([fresh(event({
    name: 'New',
    phone: '0899999999'
  })), fresh(event({
    name: 'New',
    phone: '0899999999'
  }))]);
  assert.equal(Object.keys(f.state.customers).length, 2);
});
test('member loading restricts identity and points/history to the owner', () => {
  const f = fixture({
    transactions: {
      x: {
        id: 'x',
        customerId: 'm'
      },
      y: {
        id: 'y',
        customerId: 'foreign'
      }
    },
    customers: {
      m: {
        id: 'm',
        lineUserId: actor.sub,
        points: 10
      },
      foreign: {
        id: 'foreign',
        lineUserId: 'other'
      }
    }
  });
  const state = selectMemberState(f.state, actor);
  assert.equal(state.customers.length, 1);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.customers[0].points, 10);
  assert.equal(state.security, undefined);
});
test('database refuses production and missing target', () => {
  delete process.env.FIREBASE_DATABASE_URL;
  assert.throws(databaseUrl);
  process.env.FIREBASE_DATABASE_URL = 'https://piyasiri-member-system-default-rtdb.asia-southeast1.firebasedatabase.app';
  assert.throws(databaseUrl, /production_disabled/);
  delete process.env.FIREBASE_DATABASE_URL;
});
test('missing ETag aborts without an unconditional write', async () => {
  let writes = 0;
  const tx = createTransaction({
    read: async () => ({
      value: {}
    }),
    put: async () => {
      writes++;
    }
  });
  await assert.rejects(tx(() => {}), /etag_missing/);
  assert.equal(writes, 0);
});
test('frontend has no password, Firebase writes, deletion or sessionStorage auth boundary', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /ADMIN_PASSCODE|firebase-database|saveCloudDoc|deleteCloudDoc|clearCloudState|sessionStorage\.getItem\(ADMIN_SESSION_KEY\)/);
  assert.match(html, /api\.mutate\('reward-redemption'/);
});
test('admin approval credits once, reward archive retains the original record', async () => {
  const f = fixture({
      pendingPurchases: {
        p: {
          id: 'p',
          customerId: 'm',
          amount: 500,
          status: 'pending'
        }
      }
    }),
    h = createAdminOperationsHandler({
      tx: f.tx,
      authenticate: e => adminAuth(e, {
        read: f.read
      })
    });
  const body = {
    action: 'approve',
    id: 'p',
    amount: 500,
    operationId: 'approve-once'
  };
  assert.equal((await h(event(body, headers()))).statusCode, 200);
  assert.equal((await h(event(body, headers()))).statusCode, 200);
  assert.equal(f.state.customers.m.points, 15);
  assert.equal(Object.keys(f.state.transactions).length, 1);
  assert.equal(f.state.pendingPurchases.p.status, 'approved');
  assert.equal((await h(event({
    action: 'reward-archive',
    id: 'r',
    operationId: 'archive'
  }, headers()))).statusCode, 200);
  assert.equal(f.state.rewards.r.archived, true);
  assert.equal(f.state.rewards.r.stock, 2);
});
test('logout revokes copied cookies server-side', async () => {
  const f = fixture(),
    authenticate = e => adminAuth(e, {
      read: f.read
    }),
    h = createAdminSessionHandler({
      tx: f.tx,
      authenticate
    });
  const hdr = headers();
  assert.equal((await h(event({
    action: 'logout'
  }, hdr))).statusCode, 200);
  await assert.rejects(authenticate(event({}, hdr)), {
    statusCode: 401
  });
});
test('weak former-style passcodes cannot log in even with a matching configured hash', async () => {
  const f = fixture();
  process.env.ADMIN_PASSWORD_SALT = 'fixture-salt-not-a-secret';
  process.env.ADMIN_PASSWORD_HASH = scryptSync('short', process.env.ADMIN_PASSWORD_SALT, 64).toString('hex');
  await assert.rejects(login(event({}, {
    origin: process.env.APP_ORIGIN
  }), 'short', {
    tx: f.tx
  }), {
    statusCode: 401
  });
});

test('simultaneous registrations retain the existing MB-number format with unique codes', async () => {
  const f = fixture();
  const make = (sub, phone) => createMemberProfileHandler({tx:f.tx, authenticate:async()=>({role:'member',sub})})(event({name:'Fixture',phone}));
  await Promise.all([make('new-one','0881111111'),make('new-two','0882222222')]);
  const codes = Object.values(f.state.customers).filter(c=>c.code).map(c=>c.code);
  assert.equal(new Set(codes).size,2);
  assert.ok(codes.every(code=>/^MB-\d{4}$/.test(code)));
});
