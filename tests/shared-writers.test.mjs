import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, actor, event } from './helpers.mjs';
import { redeem } from '../netlify/functions/reward-redemption.mjs';
import { saleOperation, createSaleHandler } from '../netlify/functions/sync-sale-points.mjs';
import { handler as rewardSync } from '../netlify/functions/sync-rewards.mjs';
import { createNotificationHandler, notifyRecord } from '../netlify/functions/send-line-message.mjs';
import { handler as audit } from '../netlify/functions/member-audit.mjs';
import { readFile } from 'node:fs/promises';
import { config as scheduledConfig } from '../netlify/functions/notify-expiring-points.mjs';
test('shared HTTP writers reject unauthenticated requests before I/O', async () => {
  delete process.env.SHEET_SYNC_SECRET;
  assert.equal((await createSaleHandler()(event({}))).statusCode, 401);
  assert.equal((await rewardSync(event({}))).statusCode, 401);
  assert.ok((await createNotificationHandler()(event({}, {
    origin: 'https://invalid'
  }))).statusCode >= 400);
  assert.equal((await audit({
    httpMethod: 'GET',
    headers: {}
  })).statusCode, 401);
});
test('legacy absolute stock sync is blocked even with valid service credentials', async () => {
  process.env.SHEET_SYNC_SECRET = 'fixture-only';
  const result = await rewardSync(event({
    rewards: []
  }, {
    'x-sheet-sync-secret': process.env.SHEET_SYNC_SECRET
  }));
  assert.equal(result.statusCode, 503);
  assert.match(result.body, /blocked_reward_stock_contract_review/);
});
test('sale reversal races redemption without lost updates or negative balance', async () => {
  const f = fixture({
    customers: {
      m: {
        id: 'm',
        lineUserId: actor.sub,
        points: 5,
        totalSpend: 500
      }
    },
    transactions: {
      sale: {
        id: 'sale',
        customerId: 'm',
        type: 'earn',
        status: 'confirmed',
        ref: 'bill',
        points: 5,
        amount: 500
      }
    }
  });
  const results = await Promise.allSettled([f.tx(root => redeem(root, {
    rewardId: 'r',
    operationId: 'redeem'
  }, actor)), f.tx(root => saleOperation(root, {
    action: 'reverse',
    ref: 'bill'
  }))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.state.customers.m.points, 0);
  assert.ok(f.state.rewards.r.stock >= 0);
});
test('notification marks metadata without overwriting concurrent balance changes', async () => {
  const f = fixture({
    transactions: {
      earned: {
        id: 'earned',
        customerId: 'm',
        type: 'earn',
        points: 5,
        expiresAt: '2099-01-01'
      }
    }
  });
  await Promise.all([notifyRecord({
    type: 'points_expiring',
    id: 'earned'
  }, {
    tx: f.tx,
    push: async () => ({
      ok: true
    })
  }), f.tx(root => redeem(root, {
    rewardId: 'r',
    operationId: 'debit'
  }, actor))]);
  assert.equal(f.state.customers.m.points, 5);
  assert.ok(f.state.transactions.earned.expiryNotifiedAt);
  assert.equal(Object.keys(f.state.redemptions).length, 1);
});
test('proposed rules deny all browser access and schedules remain non-public', async () => {
  const rules = JSON.parse(await readFile(new URL('../firebase/database.rules.proposed.json', import.meta.url)));
  assert.deepEqual(rules, {
    rules: {
      '.read': false,
      '.write': false
    }
  });
  assert.equal(scheduledConfig.schedule, '@daily');
});
test('sale confirmation and recalculation are atomic and payload-bound on retries', async () => {
  const f = fixture();
  const body = {
    ref: 'BILL-1',
    phone: '0812345678',
    pointResult: {
      points: 5,
      amount: 500,
      breakdown: [{
        points: 5
      }]
    }
  };
  const first = await f.tx(root => saleOperation(root, body)),
    retry = await f.tx(root => saleOperation(root, body));
  assert.equal(first.transactionId, retry.transactionId);
  assert.equal(f.state.customers.m.points, 15);
  await assert.rejects(f.tx(root => saleOperation(root, {
    ...body,
    pointResult: {
      points: 6,
      amount: 600,
      breakdown: [{
        points: 6
      }]
    }
  })), /idempotency_payload_mismatch/);
  await f.tx(root => saleOperation(root, {
    action: 'recalculate',
    ref: 'BILL-1',
    operationId: 'revision-1',
    pointResult: {
      points: 3,
      amount: 300,
      breakdown: [{
        points: 3
      }]
    }
  }));
  assert.equal(f.state.customers.m.points, 13);
  assert.equal(f.state.customers.m.totalSpend, 300);
  assert.equal(f.state.transactions[first.transactionId].status, 'revised');
});
test('retry after a lost sale response does not duplicate a financial transaction', async () => {
  const f = fixture(),
    body = {
      ref: 'BILL-2',
      phone: '0812345678',
      pointResult: {
        points: 5,
        amount: 500,
        breakdown: [{
          points: 5
        }]
      }
    };
  f.loseResponse();
  await assert.rejects(f.tx(root => saleOperation(root, body)));
  const retry = await f.tx(root => saleOperation(root, body));
  assert.equal(retry.replayed, true);
  assert.equal(f.state.customers.m.points, 15);
  assert.equal(Object.keys(f.state.transactions).length, 1);
});
test('notification retry preserves the exact payload and LINE retry key', async () => {
  const f = fixture({
      transactions: {
        earned: {
          id: 'earned',
          customerId: 'm',
          type: 'earn',
          points: 5
        }
      }
    }),
    sent = [];
  const push = async (...args) => {
    sent.push(args);
    return {
      ok: sent.length > 1
    };
  };
  await notifyRecord({
    type: 'approved_points',
    id: 'earned'
  }, {
    tx: f.tx,
    push
  });
  await f.tx(root => {
    root.customers.m.points = 20;
  });
  await notifyRecord({
    type: 'approved_points',
    id: 'earned'
  }, {
    tx: f.tx,
    push
  });
  await notifyRecord({
    type: 'approved_points',
    id: 'earned'
  }, {
    tx: f.tx,
    push
  });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
});
