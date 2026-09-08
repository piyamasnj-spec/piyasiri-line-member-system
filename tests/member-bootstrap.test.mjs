import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createMemberBootstrapCoordinator,
  loadMemberBootstrapData,
  MEMBER_BOOTSTRAP_STATUS,
  MemberBootstrapError,
  memberViewMode
} from "../src/member-bootstrap.mjs";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const normalizedHtml = html.replace(/\r\n?/g, "\n");
const moduleSource = await readFile(new URL("../src/member-bootstrap.mjs", import.meta.url), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function supplemental(overrides = {}) {
  return {
    transactions: [],
    pendingPurchases: [],
    redemptions: [],
    rewards: [],
    ...overrides
  };
}

test("existing member cold start stays loading until the real member record is ready", async () => {
  const phases = [];
  const coordinator = createMemberBootstrapCoordinator("#member");
  const run = coordinator.begin("#member");
  assert.equal(memberViewMode({ status: run.status, customer: null }), "loading");

  const loaded = await loadMemberBootstrapData({
    lineUserId: "U-existing",
    loadCustomers: async () => [{ id: "member-1", lineUserId: "U-existing", name: "สมาชิกเดิม", points: 58 }],
    loadSupplementalState: async () => supplemental(),
    onPhase: phase => phases.push(phase)
  });
  const ready = coordinator.complete(run.generation, loaded);

  assert.equal(ready.status, MEMBER_BOOTSTRAP_STATUS.READY);
  assert.equal(ready.payload.customer.id, "member-1");
  assert.equal(memberViewMode({ status: ready.status, customer: ready.payload.customer }), "member");
  assert.deepEqual(phases, ["member-lookup-start", "member-found", "member-data-ready"]);
});

test("slow member lookup cannot render a guest or signup state while pending", async () => {
  const customers = deferred();
  const coordinator = createMemberBootstrapCoordinator("#member");
  const run = coordinator.begin("#member");
  const loading = loadMemberBootstrapData({
    lineUserId: "U-existing",
    loadCustomers: () => customers.promise,
    loadSupplementalState: async () => supplemental()
  });

  const pending = coordinator.snapshot();
  assert.equal(pending.status, MEMBER_BOOTSTRAP_STATUS.LOADING);
  assert.equal(memberViewMode({ status: pending.status, customer: null }), "loading");

  customers.resolve([{ id: "member-1", lineUserId: "U-existing", points: 58 }]);
  const loaded = await loading;
  const ready = coordinator.complete(run.generation, loaded);
  assert.equal(memberViewMode({ status: ready.status, customer: ready.payload.customer }), "member");
});

test("signup is allowed only after a successful lookup confirms no member", async () => {
  const coordinator = createMemberBootstrapCoordinator("#member");
  const run = coordinator.begin("#member");
  const loaded = await loadMemberBootstrapData({
    lineUserId: "U-new",
    loadCustomers: async () => [{ id: "member-1", lineUserId: "U-existing" }],
    loadSupplementalState: async () => supplemental()
  });
  const ready = coordinator.complete(run.generation, loaded);

  assert.equal(loaded.customer, null);
  assert.equal(memberViewMode({ status: ready.status, customer: ready.payload.customer }), "guest");
});

test("network failure becomes an error state and is never treated as a missing member", async () => {
  const coordinator = createMemberBootstrapCoordinator("#member");
  const run = coordinator.begin("#member");
  const networkError = new TypeError("Failed to fetch");

  await assert.rejects(
    loadMemberBootstrapData({
      lineUserId: "U-existing",
      loadCustomers: async () => { throw networkError; },
      loadSupplementalState: async () => supplemental()
    }),
    error => error instanceof MemberBootstrapError && error.code === "MEMBER_LOOKUP_FAILED"
  );
  const failed = coordinator.fail(run.generation, networkError);
  assert.equal(memberViewMode({ status: failed.status, customer: null }), "error");
  assert.notEqual(memberViewMode({ status: failed.status, customer: null }), "guest");
});

test("the latest requested route is restored once member data becomes ready", () => {
  for (const route of ["#member", "#promotions", "#rewards", "#history", "#profile"]) {
    const coordinator = createMemberBootstrapCoordinator("#member");
    const run = coordinator.begin("#member");
    coordinator.requestRoute(route);
    const ready = coordinator.complete(run.generation, { customer: { id: "member-1" } });
    assert.equal(ready.requestedHash, route);
    assert.equal(ready.status, MEMBER_BOOTSTRAP_STATUS.READY);
  }
});

test("one bottom-navigation request changes the ready route immediately", () => {
  const coordinator = createMemberBootstrapCoordinator("#member");
  const run = coordinator.begin("#member");
  coordinator.complete(run.generation, { customer: { id: "member-1" } });

  const afterOneClick = coordinator.requestRoute("#rewards");
  assert.equal(afterOneClick.requestedHash, "#rewards");
  assert.equal(afterOneClick.status, MEMBER_BOOTSTRAP_STATUS.READY);
  assert.equal(memberViewMode({ status: afterOneClick.status, customer: afterOneClick.payload.customer }), "member");
});

test("integration gates customer rendering and preserves the audited bootstrap order without timers", () => {
  assert.match(html, /function renderMemberBootstrapLoading\(\)[\s\S]*?กำลังตรวจสอบข้อมูลสมาชิก/);
  assert.match(html, /if \(mode === "loading"\)[\s\S]*?renderMemberBootstrapLoading\(\)[\s\S]*?return;/);
  assert.match(html, /if \(mode === "error"\)[\s\S]*?renderMemberBootstrapError/);
  assert.doesNotMatch(moduleSource, /setTimeout|setInterval/);

  const boot = normalizedHtml.match(/async function boot\([\s\S]*?\n    }\n\n    boot\(\);/)?.[0] || "";
  const order = [
    "liff-init-start",
    "profile-ready",
    "loadCloudState",
    "route-restored",
    "render-ready"
  ].map(token => boot.indexOf(token));
  assert.equal(order.every(index => index >= 0), true);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});
