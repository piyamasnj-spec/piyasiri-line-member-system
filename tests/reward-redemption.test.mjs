import test from 'node:test';
import assert from 'node:assert/strict';
import { createRewardRedemptionHandler } from '../netlify/functions/reward-redemption.mjs';
import { adminAuth, signSession, cookieName } from '../netlify/functions/lib/auth.mjs';
import { fixture, actor, admin, event, parsed } from './helpers.mjs';
const request = (overrides = {}) => ({
  action: 'request',
  rewardId: 'r',
  operationId: 'op-1',
  ...overrides
});
function setup(overrides = {}) {
  const f = fixture(overrides);
  const handler = createRewardRedemptionHandler({
    tx: f.tx,
    authenticateMember: async e => {
      if (e.headers.authorization !== 'Bearer fixture') throw Object.assign(new Error('invalid_line_identity'), {
        statusCode: 401
      });
      return actor;
    },
    authenticateAdmin: e => adminAuth(e, {
      read: f.read
    })
  });
  process.env.APP_ORIGIN = 'https://staging.example';
  process.env.ADMIN_SESSION_SECRET = 'test-only-session-key-'.repeat(3);
  const call = async body => parsed(await handler(event(body, {
    authorization: 'Bearer fixture'
  })));
  const manage = async body => parsed(await handler(event(body, {
    origin: process.env.APP_ORIGIN,
    cookie: `${cookieName}=${signSession(admin)}`
  })));
  return {
    f,
    handler,
    call,
    manage
  };
}
test('regression: anonymous normal redemption cannot deduct points', async () => {
  const {
    handler,
    f
  } = setup();
  const before = f.state;
  assert.equal((await handler(event(request()))).statusCode, 401);
  assert.deepEqual(f.state, before);
});
test('successful redemption commits points, stock, history and receipt together', async () => {
  const {
    call,
    f
  } = setup();
  const r = await call(request());
  assert.equal(r.status, 200);
  assert.equal(f.state.customers.m.points, 5);
  assert.equal(f.state.rewards.r.stock, 1);
  assert.equal(Object.keys(f.state.redemptions).length, 1);
  assert.equal(Object.keys(f.state.transactions).length, 1);
  assert.equal(Object.keys(f.state.secureOperations).length, 1);
  assert.deepEqual(f.state.unrelated, {
    preserved: true
  });
});
for (const [name, overrides] of [['insufficient points', {
  customers: {
    m: {
      id: 'm',
      lineUserId: actor.sub,
      points: 4
    }
  }
}], ['insufficient stock', {
  rewards: {
    r: {
      id: 'r',
      points: 5,
      stock: 0,
      active: true
    }
  }
}], ['inactive reward', {
  rewards: {
    r: {
      id: 'r',
      points: 5,
      stock: 2,
      active: false
    }
  }
}], ['invalid member', {
  customers: {}
}], ['invalid reward', {
  rewards: {}
}], ['corrupt points', {
  customers: {
    m: {
      id: 'm',
      lineUserId: actor.sub,
      points: 'NaN'
    }
  }
}]]) test(`${name} makes no changes`, async () => {
  const {
      call,
      f
    } = setup(overrides),
    before = f.state;
  const r = await call(request());
  assert.ok(r.status >= 400);
  assert.deepEqual(f.state, before);
});
test('member ID from request cannot impersonate another member', async () => {
  const {
    call,
    f
  } = setup();
  assert.equal((await call(request({
    memberId: 'someone-else'
  }))).status, 403);
  assert.equal(f.state.customers.m.points, 10);
});
for (const quantity of [0, -1, 1.5, 'bad', Number.MAX_SAFE_INTEGER]) test(`invalid or impossible quantity ${quantity} denied`, async () => {
  const {
    call,
    f
  } = setup();
  assert.ok((await call(request({
    quantity
  }))).status >= 400);
  assert.equal(f.state.customers.m.points, 10);
});
test('duplicate/retry/replay returns same receipt without deducting again', async () => {
  const {
    call,
    f
  } = setup();
  const a = await call(request()),
    b = await call(request());
  assert.equal(a.redemptionId, b.redemptionId);
  assert.equal(b.replayed, true);
  assert.equal(f.state.customers.m.points, 5);
});
test('same idempotency key with changed payload rejected', async () => {
  const {
    call,
    f
  } = setup();
  await call(request());
  assert.equal((await call(request({
    quantity: 2
  }))).status, 409);
  assert.equal(f.state.customers.m.points, 5);
});
test('double-click same key commits one receipt under contention', async () => {
  const {
    call,
    f
  } = setup();
  const r = await Promise.all([call(request()), call(request())]);
  assert.deepEqual(r.map(x => x.status), [200, 200]);
  assert.equal(r[0].redemptionId, r[1].redemptionId);
  assert.equal(Object.keys(f.state.redemptions).length, 1);
  assert.ok(f.conflicts > 0);
});
test('regression: simultaneous distinct operationIds cannot overspend points', async () => {
  const {
    call,
    f
  } = setup({
    customers: {
      m: {
        id: 'm',
        lineUserId: actor.sub,
        points: 5
      }
    }
  });
  const r = await Promise.all([call(request()), call(request({
    operationId: 'op-2'
  }))]);
  assert.deepEqual(r.map(x => x.status).sort(), [200, 409]);
  assert.equal(f.state.customers.m.points, 0);
  assert.equal(Object.keys(f.state.redemptions).length, 1);
});
test('simultaneous distinct members cannot oversell shared stock', async () => {
  const f = fixture({
    customers: {
      m: {
        id: 'm',
        lineUserId: 'one',
        points: 10
      },
      n: {
        id: 'n',
        lineUserId: 'two',
        points: 10
      }
    },
    rewards: {
      r: {
        id: 'r',
        points: 5,
        stock: 1,
        active: true
      }
    }
  });
  const handler = createRewardRedemptionHandler({
    tx: f.tx,
    authenticateMember: async e => ({
      role: 'member',
      sub: e.headers.subject
    })
  });
  const r = await Promise.all(['one', 'two'].map((subject, i) => handler(event(request({
    operationId: 'op-' + i
  }), {
    subject
  }))));
  assert.deepEqual(r.map(x => x.statusCode).sort(), [200, 409]);
  assert.equal(f.state.rewards.r.stock, 0);
  assert.equal(Object.keys(f.state.transactions).length, 1);
});
test('response loss after successful commit replays without a second debit', async () => {
  const {
    call,
    f
  } = setup();
  f.loseResponse();
  assert.equal((await call(request())).status, 503);
  const r = await call(request());
  assert.equal(r.status, 200);
  assert.equal(r.replayed, true);
  assert.equal(f.state.customers.m.points, 5);
  assert.equal(Object.keys(f.state.redemptions).length, 1);
});
test('failure before commit leaves neither debit nor redemption', async () => {
  const {
      call,
      f
    } = setup(),
    before = f.state;
  f.failWrite();
  assert.equal((await call(request())).status, 503);
  assert.deepEqual(f.state, before);
  assert.equal((await call(request())).status, 200);
});
test('anonymous cancellation denied, authorized cancellation refunds once', async () => {
  const {
    call,
    manage,
    handler,
    f
  } = setup();
  const r = await call(request());
  const b = {
    action: 'cancel',
    redemptionId: r.redemptionId
  };
  assert.equal((await handler(event(b, {
    origin: process.env.APP_ORIGIN
  }))).statusCode, 401);
  assert.equal((await manage(b)).status, 200);
  assert.equal((await manage(b)).status, 200);
  assert.equal(f.state.customers.m.points, 10);
  assert.equal(f.state.rewards.r.stock, 2);
  assert.equal(Object.keys(f.state.transactions).length, 2);
});
test('cancel/complete race permits only one final transition', async () => {
  const {
    call,
    manage,
    f
  } = setup();
  const r = await call(request());
  const results = await Promise.all(['complete', 'cancel'].map(action => manage({
    action,
    redemptionId: r.redemptionId
  })));
  assert.deepEqual(results.map(x => x.status).sort(), [200, 409]);
  const status = f.state.redemptions[r.redemptionId].status;
  assert.equal(f.state.customers.m.points, status === 'completed' ? 5 : 10);
  assert.equal(f.state.rewards.r.stock, status === 'completed' ? 1 : 2);
});
test('cancellation uses stored snapshot after reward price changes', async () => {
  const {
    call,
    manage,
    f
  } = setup();
  const r = await call(request());
  await f.tx(root => {
    root.rewards.r.points = 999;
  });
  await manage({
    action: 'cancel',
    redemptionId: r.redemptionId
  });
  assert.equal(f.state.customers.m.points, 10);
});
test('testMode requires service authentication and TEST namespace', async () => {
  const {
    handler,
    f
  } = setup();
  process.env.SHEET_SYNC_SECRET = 'fixture-service-only';
  const b = {
    ...request(),
    testMode: true,
    redemptionId: 'TEST-r',
    memberId: 'm'
  };
  assert.equal((await handler(event(b))).statusCode, 401);
  assert.equal((await handler(event(b, {
    'x-sheet-sync-secret': process.env.SHEET_SYNC_SECRET
  }))).statusCode, 400);
  assert.equal(f.state.customers.m.points, 10);
});
test('authorized TEST request/cancel keeps TEST IDs and snapshots; replay refunds once', async () => {
  const f = fixture({
    customers: {
      m: {
        id: 'TEST-m',
        points: 10
      }
    },
    rewards: {
      r: {
        id: 'TEST-r',
        points: 5,
        stock: 2,
        active: true,
        name: 'Test'
      }
    }
  });
  const h = createRewardRedemptionHandler({
    tx: f.tx
  });
  process.env.SHEET_SYNC_SECRET = 'fixture-service-only';
  const hdr = {
    'x-sheet-sync-secret': process.env.SHEET_SYNC_SECRET
  };
  const body = {
    testMode: true,
    memberId: 'TEST-m',
    rewardId: 'TEST-r',
    redemptionId: 'TEST-redemption',
    operationId: 'TEST-request'
  };
  const first = JSON.parse((await h(event(body, hdr))).body);
  assert.match(first.transactionId, /^TEST-POINTS-/);
  const cancel = {
    testMode: true,
    action: 'cancel',
    redemptionId: 'TEST-redemption'
  };
  const result = JSON.parse((await h(event(cancel, hdr))).body);
  assert.match(result.transactionId, /^TEST-REFUND-/);
  await h(event(cancel, hdr));
  assert.equal(f.state.customers.m.points, 10);
  assert.equal(f.state.rewards.r.stock, 2);
});
test('legacy cancellation without a stock snapshot fails closed, preserving data', async () => {
  const {
      manage,
      f
    } = setup({
      redemptions: {
        old: {
          id: 'old',
          customerId: 'm',
          rewardId: 'r',
          points: 5,
          status: 'requested'
        }
      }
    }),
    before = f.state;
  assert.equal((await manage({
    action: 'cancel',
    redemptionId: 'old'
  })).status, 409);
  assert.deepEqual(f.state, before);
});
