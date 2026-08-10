import test from "node:test";
import assert from "node:assert/strict";
import { createRewardRedemptionHandler } from "../netlify/functions/reward-redemption.mjs";

const TEST_HEADER_VALUE = ["unit", "test", "secret"].join("-");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function valueAt(root, path) {
  return path.split("/").filter(Boolean).reduce((value, key) => value?.[key], root);
}

function setAt(root, path, value) {
  const keys = path.split("/").filter(Boolean);
  let cursor = root;
  for (let index = 0; index < keys.length - 1; index += 1) cursor = cursor[keys[index]] ||= {};
  cursor[keys.at(-1)] = clone(value);
}

function fixture({ points = 6, stock = 2, active = true } = {}) {
  const state = {
    customers: { "test-member-key": { id: "TEST-MEMBER-001", points }, "real-member-key": { id: "REAL-MEMBER-001", points: 99 } },
    rewards: { "test-reward-key": { id: "TEST-REWARD-001", name: "Test reward", points: 5, stock, active }, "real-reward-key": { id: "REAL-REWARD-001", name: "Real reward", points: 1, stock: 10, active: true } },
    redemptions: {},
    transactions: {}
  };
  const locks = new Map();
  const stats = { reads: 0, patches: 0, claims: 0, finishes: 0 };
  let uuidCounter = 0;
  const handler = createRewardRedemptionHandler({
    firebaseRead: async (path) => {
      stats.reads += 1;
      return { value: clone(valueAt(state, path)), etag: "etag" };
    },
    firebaseRootPatch: async (updates) => {
      stats.patches += 1;
      for (const [path, value] of Object.entries(updates)) setAt(state, path, value);
      return clone(updates);
    },
    claimOperation: async (kind, reference, payload = {}) => {
      stats.claims += 1;
      const key = `${kind}:${reference}`;
      if (locks.has(key)) return { claimed: false, key, existing: clone(locks.get(key)) };
      const record = { kind, reference, status: "processing", ...clone(payload) };
      locks.set(key, record);
      return { claimed: true, key, record: clone(record) };
    },
    finishOperation: async (key, updates) => {
      stats.finishes += 1;
      locks.set(key, { ...(locks.get(key) || {}), ...clone(updates) });
    },
    randomUUID: () => `uuid-${++uuidCounter}`,
    now: () => "2026-08-10T08:00:00.000Z"
  });
  return { state, stats, handler };
}

function event(body, secret = TEST_HEADER_VALUE) {
  return { httpMethod: "POST", headers: secret === null ? {} : { "X-Sheet-Sync-Secret": secret }, body: JSON.stringify(body) };
}

function testRequest(overrides = {}) {
  return {
    action: "request",
    testMode: true,
    memberId: "TEST-MEMBER-001",
    rewardId: "TEST-REWARD-001",
    redemptionId: "TEST-REDEMPTION-001",
    operationId: "TEST-REDEMPTION-001",
    quantity: 1,
    operator: "TEST-OPERATOR",
    ...overrides
  };
}

async function call(handler, body, secret = TEST_HEADER_VALUE) {
  const response = await handler(event(body, secret));
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

test.beforeEach(() => {
  process.env.SHEET_SYNC_SECRET = TEST_HEADER_VALUE;
});

test("testMode accepts TEST member, reward and caller redemption ID", async () => {
  const context = fixture();
  const result = await call(context.handler, testRequest());
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.redemptionId, "TEST-REDEMPTION-001");
  assert.equal(context.state.redemptions["TEST-REDEMPTION-001"].testMode, true);
});

for (const [name, overrides, message] of [
  ["real member", { memberId: "REAL-MEMBER-001" }, "test_member_id_required"],
  ["real reward", { rewardId: "REAL-REWARD-001" }, "test_reward_id_required"],
  ["non-TEST redemption ID", { redemptionId: "redeem-real", operationId: "redeem-real" }, "test_redemption_id_required"]
]) {
  test(`testMode rejects ${name} before Firebase access`, async () => {
    const context = fixture();
    const result = await call(context.handler, testRequest(overrides));
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.message, message);
    assert.deepEqual(context.stats, { reads: 0, patches: 0, claims: 0, finishes: 0 });
  });
}

test("wrong secret returns 401 before Firebase access", async () => {
  const context = fixture();
  const result = await call(context.handler, testRequest(), "wrong-secret");
  assert.equal(result.statusCode, 401);
  assert.deepEqual(context.stats, { reads: 0, patches: 0, claims: 0, finishes: 0 });
});

test("missing secret returns 401 before Firebase access", async () => {
  const context = fixture();
  const result = await call(context.handler, testRequest(), null);
  assert.equal(result.statusCode, 401);
  assert.deepEqual(context.stats, { reads: 0, patches: 0, claims: 0, finishes: 0 });
});

test("first TEST redemption deducts points and stock once and stores its snapshot", async () => {
  const context = fixture();
  const result = await call(context.handler, testRequest());
  const redemption = context.state.redemptions["TEST-REDEMPTION-001"];
  assert.equal(result.body.totalPoints, 1);
  assert.equal(result.body.stock, 1);
  assert.equal(context.state.customers["test-member-key"].points, 1);
  assert.equal(context.state.rewards["test-reward-key"].stock, 1);
  assert.deepEqual({ memberId: redemption.memberId, rewardId: redemption.rewardId, pointsUsed: redemption.pointsUsed, quantity: redemption.quantity, stockBefore: redemption.stockBefore, stockAfter: redemption.stockAfter, stockChange: redemption.stockChange, operator: redemption.operator, status: redemption.status }, { memberId: "TEST-MEMBER-001", rewardId: "TEST-REWARD-001", pointsUsed: 5, quantity: 1, stockBefore: 2, stockAfter: 1, stockChange: -1, operator: "TEST-OPERATOR", status: "requested" });
});

test("duplicate TEST redemption ID does not deduct twice", async () => {
  const context = fixture();
  await call(context.handler, testRequest());
  const patchesAfterFirst = context.stats.patches;
  const result = await call(context.handler, testRequest());
  assert.equal(result.body.status, "duplicate");
  assert.equal(context.state.customers["test-member-key"].points, 1);
  assert.equal(context.state.rewards["test-reward-key"].stock, 1);
  assert.equal(context.stats.patches, patchesAfterFirst);
  assert.equal(Object.keys(context.state.redemptions).length, 1);
});

test("insufficient points makes no business-data changes", async () => {
  const context = fixture({ points: 4 });
  const before = clone(context.state);
  const result = await call(context.handler, testRequest());
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.message, "insufficient points");
  assert.deepEqual(context.state, before);
  assert.equal(context.stats.patches, 0);
});

test("insufficient stock makes no business-data changes", async () => {
  const context = fixture({ stock: 0 });
  const before = clone(context.state);
  const result = await call(context.handler, testRequest());
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.message, "out of stock");
  assert.deepEqual(context.state, before);
  assert.equal(context.stats.patches, 0);
});

test("TEST cancellation refunds pointsUsed and quantity from the stored redemption", async () => {
  const context = fixture();
  await call(context.handler, testRequest());
  context.state.rewards["test-reward-key"].points = 999;
  const result = await call(context.handler, { action: "cancel", testMode: true, redemptionId: "TEST-REDEMPTION-001", operator: "TEST-OPERATOR" });
  assert.equal(result.body.status, "cancelled");
  assert.equal(context.state.customers["test-member-key"].points, 6);
  assert.equal(context.state.rewards["test-reward-key"].stock, 2);
  assert.equal(context.state.redemptions["TEST-REDEMPTION-001"].status, "cancelled");
  assert.equal(context.state.redemptions["TEST-REDEMPTION-001"].cancelledAt, "2026-08-10T08:00:00.000Z");
});

test("duplicate TEST cancellation does not refund twice", async () => {
  const context = fixture();
  await call(context.handler, testRequest());
  const cancelBody = { action: "cancel", testMode: true, redemptionId: "TEST-REDEMPTION-001", operator: "TEST-OPERATOR" };
  await call(context.handler, cancelBody);
  const patchesAfterCancel = context.stats.patches;
  const result = await call(context.handler, cancelBody);
  assert.equal(result.body.status, "duplicate_cancel");
  assert.equal(context.state.customers["test-member-key"].points, 6);
  assert.equal(context.state.rewards["test-reward-key"].stock, 2);
  assert.equal(context.stats.patches, patchesAfterCancel);
});

test("production request keeps legacy behavior without TEST prefix or sheet secret", async () => {
  const context = fixture({ points: 10, stock: 5 });
  delete context.state.rewards["real-reward-key"].active;
  const result = await call(context.handler, { action: "request", operationId: "real-operation-001", customerId: "REAL-MEMBER-001", rewardId: "REAL-REWARD-001", quantity: 1 }, null);
  assert.equal(result.statusCode, 200);
  assert.match(result.body.redemptionId, /^redeem-/);
  assert.equal(context.state.customers["real-member-key"].points, 98);
  assert.equal(context.state.rewards["real-reward-key"].stock, 9);
});

test("production cancellation keeps legacy refund behavior without TEST mode", async () => {
  const context = fixture();
  const request = await call(context.handler, { action: "request", operationId: "real-operation-002", customerId: "REAL-MEMBER-001", rewardId: "REAL-REWARD-001", quantity: 1 }, null);
  const result = await call(context.handler, { action: "cancel", redemptionId: request.body.redemptionId, operator: "admin" }, null);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "cancelled");
  assert.equal(context.state.customers["real-member-key"].points, 99);
  assert.equal(context.state.rewards["real-reward-key"].stock, 10);
});
