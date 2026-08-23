import assert from "node:assert/strict";
import test from "node:test";
import { stableKey } from "../netlify/functions/lib/firebase-rest.mjs";
import { handler } from "../netlify/functions/sync-sale-points.mjs";

const FIREBASE_URL = "https://mock-firebase.invalid";
const LINE_URL = "https://api.line.me/v2/bot/message/push";

process.env.FIREBASE_DATABASE_URL = FIREBASE_URL;
process.env.SHEET_SYNC_SECRET = "test-secret";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "mock-line-token";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function getAt(root, path) {
  return path.split("/").filter(Boolean).reduce((value, key) => value?.[key], root);
}

function setAt(root, path, value) {
  const parts = path.split("/").filter(Boolean);
  let target = root;
  for (const part of parts.slice(0, -1)) target = target[part] ||= {};
  target[parts.at(-1)] = clone(value);
}

function response(value, { ok = true, status = 200, etag = '"mock-etag"' } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => name.toLowerCase() === "etag" ? etag : null },
    json: async () => clone(value)
  };
}

function createHarness({ lineUserId = "U-test", lineOk = true } = {}) {
  const state = {
    customers: {
      member1: { id: "MB-0001", phone: "0623418092", name: "\u0e2a\u0e21\u0e32\u0e0a\u0e34\u0e01\u0e17\u0e14\u0e2a\u0e2d\u0e1a", lineUserId, points: 62, totalSpend: 200 }
    },
    transactions: {
      "sheet-original": { id: "sheet-original", customerId: "MB-0001", type: "earn", status: "confirmed", amount: 200, points: 4, ref: "TEST-PROMO-006" }
    },
    operationLocks: {}
  };
  const lineCalls = [];
  const firebasePatches = [];

  async function fetchMock(url, options = {}) {
    if (url === LINE_URL) {
      lineCalls.push(JSON.parse(options.body));
      return response({}, { ok: lineOk, status: lineOk ? 200 : 503 });
    }
    assert.ok(url.startsWith(FIREBASE_URL), `unexpected network call: ${url}`);
    const path = new URL(url).pathname.replace(/^\//, "").replace(/\.json$/, "");
    const method = options.method || "GET";
    if (method === "GET") return response(getAt(state, path));
    if (method === "PUT") {
      const value = JSON.parse(options.body);
      setAt(state, path, value);
      return response(value);
    }
    if (method === "PATCH") {
      const updates = JSON.parse(options.body);
      firebasePatches.push(clone(updates));
      for (const [updatePath, value] of Object.entries(updates)) setAt(state, updatePath, value);
      return response(updates);
    }
    throw new Error(`unexpected Firebase method: ${method}`);
  }

  return { state, lineCalls, firebasePatches, fetchMock };
}

function event(body) {
  return {
    httpMethod: "POST",
    headers: { "x-sheet-sync-secret": "test-secret" },
    body: JSON.stringify(body)
  };
}

function parse(result) {
  assert.equal(result.statusCode, 200);
  return JSON.parse(result.body);
}

async function withHarness(options, run) {
  const originalFetch = global.fetch;
  const harness = createHarness(options);
  global.fetch = harness.fetchMock;
  try {
    await run(harness);
  } finally {
    global.fetch = originalFetch;
  }
}

test("reverse succeeds, notifies after commit, and sends the exact Thai message", async () => {
  await withHarness({}, async ({ state, lineCalls }) => {
    const result = parse(await handler(event({ action: "reverse", ref: "TEST-PROMO-006", transactionId: "reverse-test", operator: "tester@example.com" })));
    assert.equal(result.status, "reversed");
    assert.equal(result.notificationSent, true);
    assert.equal(result.notificationError, undefined);
    assert.equal(result.points, 4);
    assert.equal(result.totalPoints, 58);
    assert.equal(state.customers.member1.points, 58);
    assert.equal(state.transactions["sheet-original"].status, "reversed");
    assert.equal(state.transactions["reverse-test"].status, "confirmed");
    assert.equal(state.transactions["reverse-test"].notificationSent, true);
    assert.equal(lineCalls.length, 1);
    assert.equal(lineCalls[0].to, "U-test");
    assert.equal(lineCalls[0].messages[0].text, "\u0e22\u0e01\u0e40\u0e25\u0e34\u0e01\u0e04\u0e30\u0e41\u0e19\u0e19\u0e08\u0e32\u0e01\u0e1a\u0e34\u0e25 TEST-PROMO-006 \u0e08\u0e33\u0e19\u0e27\u0e19 4 \u0e04\u0e30\u0e41\u0e19\u0e19\n\u0e04\u0e30\u0e41\u0e19\u0e19\u0e04\u0e07\u0e40\u0e2b\u0e25\u0e37\u0e2d 58 \u0e04\u0e30\u0e41\u0e19\u0e19");
    const lock = state.operationLocks[stableKey("sale-reverse:TEST-PROMO-006")];
    assert.equal(lock.status, "completed");
  });
});

test("LINE API failure does not roll back the reversed points", async () => {
  await withHarness({ lineOk: false }, async ({ state, lineCalls }) => {
    const result = parse(await handler(event({ action: "reverse", ref: "TEST-PROMO-006", transactionId: "reverse-line-fail" })));
    assert.equal(result.status, "reversed");
    assert.equal(result.notificationSent, false);
    assert.match(result.notificationError, /503/);
    assert.equal(state.customers.member1.points, 58);
    assert.equal(state.transactions["sheet-original"].status, "reversed");
    assert.equal(state.transactions["reverse-line-fail"].notificationSent, false);
    assert.match(state.transactions["reverse-line-fail"].notificationError, /503/);
    assert.equal(lineCalls.length, 1);
  });
});

test("missing lineUserId reverses normally without calling LINE", async () => {
  await withHarness({ lineUserId: "" }, async ({ state, lineCalls }) => {
    const result = parse(await handler(event({ action: "reverse", ref: "TEST-PROMO-006", transactionId: "reverse-no-line" })));
    assert.equal(result.status, "reversed");
    assert.equal(result.notificationSent, false);
    assert.equal(result.notificationError, "missing-token-or-line-user-id");
    assert.equal(state.customers.member1.points, 58);
    assert.equal(lineCalls.length, 0);
  });
});

test("duplicate reverse neither subtracts nor notifies twice", async () => {
  await withHarness({}, async ({ state, lineCalls }) => {
    const first = parse(await handler(event({ action: "reverse", ref: "TEST-PROMO-006", transactionId: "reverse-once" })));
    const second = parse(await handler(event({ action: "reverse", ref: "TEST-PROMO-006", transactionId: "reverse-twice" })));
    assert.equal(first.status, "reversed");
    assert.equal(second.status, "duplicate_reverse");
    assert.equal(second.transactionId, "reverse-once");
    assert.equal(state.customers.member1.points, 58);
    assert.equal(lineCalls.length, 1);
    assert.equal(state.transactions["reverse-twice"], undefined);
  });
});

test("confirm regression still adds points and sends its original notification", async () => {
  await withHarness({}, async ({ state, lineCalls }) => {
    state.customers.member1.points = 58;
    state.customers.member1.totalSpend = 0;
    state.transactions = {};
    const pointResult = { amount: 200, points: 4, breakdown: [{ category: "\u0e17\u0e14\u0e2a\u0e2d\u0e1a", amount: 200, points: 4 }] };
    const result = parse(await handler(event({ action: "confirm", phone: "0623418092", ref: "TEST-CONFIRM-REGRESSION", transactionId: "confirm-regression", pointResult })));
    assert.equal(result.status, "synced");
    assert.equal(result.points, 4);
    assert.equal(result.totalPoints, 62);
    assert.equal(result.notification.sent, true);
    assert.equal(state.customers.member1.points, 62);
    assert.equal(state.transactions["confirm-regression"].status, "confirmed");
    assert.equal(lineCalls.length, 1);
    assert.match(lineCalls[0].messages[0].text, /\u0e40\u0e1e\u0e34\u0e48\u0e21\u0e04\u0e30\u0e41\u0e19\u0e19\u0e43\u0e2b\u0e49\u0e41\u0e25\u0e49\u0e27 \+4 \u0e04\u0e30\u0e41\u0e19\u0e19/);
  });
});



