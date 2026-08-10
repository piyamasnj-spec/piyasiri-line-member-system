import test from "node:test";
import assert from "node:assert/strict";
import { buildRewardSyncPlan } from "../netlify/functions/sync-rewards.mjs";

const existing = [
  { firebaseKey: "real-a", id: "A", name: "A", cost: 1, points: 10, stock: 3, active: true, description: "", recommendedPoints: 2, riskWarning: "", imageUrl: "a.jpg" },
  { firebaseKey: "real-b", id: "B", name: "B", cost: 2, points: 20, stock: 4, active: true, description: "", recommendedPoints: 3, riskWarning: "", imageUrl: "b.jpg" },
  { firebaseKey: "real-c", id: "C", name: "C", cost: 3, points: 30, stock: 5, active: true, description: "", recommendedPoints: 4, riskWarning: "", imageUrl: "c.jpg" }
];

const testReward = { rewardCode: "TEST-REWARD-001", name: "ของรางวัลทดสอบ", cost: 4, points: 5, stock: 2, active: "ใช่", note: "", recommendedPoints: 5, riskWarning: "" };

test("partial is the safe default and does not change A, B or C", () => {
  const plan = buildRewardSyncPlan({ testMode: true, rewards: [testReward] }, existing, "2026-08-03T00:00:00.000Z");
  assert.equal(plan.mode, "partial");
  assert.deepEqual(Object.keys(plan.updates), ["rewards/TEST-REWARD-001"]);
  assert.equal(plan.updates["rewards/real-a/active"], undefined);
  assert.equal(plan.updates["rewards/real-b/active"], undefined);
  assert.equal(plan.updates["rewards/real-c/active"], undefined);
});

test("partial updates only an existing TEST reward", () => {
  const previous = { firebaseKey: "test-key", id: "TEST-REWARD-001", name: "เก่า", cost: 4, points: 6, stock: 1, active: true, description: "", recommendedPoints: 5, riskWarning: "", imageUrl: "test.jpg" };
  const plan = buildRewardSyncPlan({ mode: "partial", testMode: true, rewards: [testReward] }, [...existing, previous]);
  assert.deepEqual(Object.keys(plan.updates), ["rewards/test-key"]);
  assert.equal(plan.updates["rewards/test-key"].points, 5);
  assert.equal(plan.updates["rewards/test-key"].stock, 2);
  assert.equal(plan.updates["rewards/test-key"].imageUrl, "test.jpg");
});

test("sending the identical TEST reward again is idempotent", () => {
  const previous = { firebaseKey: "test-key", id: "TEST-REWARD-001", name: "ของรางวัลทดสอบ", cost: 4, points: 5, stock: 2, active: true, description: "", recommendedPoints: 5, riskWarning: "", imageUrl: "" };
  const plan = buildRewardSyncPlan({ mode: "partial", testMode: true, rewards: [testReward] }, [...existing, previous]);
  assert.deepEqual(plan.updates, {});
  assert.equal(plan.unchanged, 1);
});

test("full sync disables omitted rewards only when explicitly requested", () => {
  const plan = buildRewardSyncPlan({ mode: "full", rewards: [{ id: "A", name: "A", cost: 1, points: 10, stock: 3, active: true, recommendedPoints: 2 }] }, existing);
  assert.equal(plan.updates["rewards/real-b/active"], false);
  assert.equal(plan.updates["rewards/real-c/active"], false);
});

test("test mode rejects a non-TEST reward before producing updates", () => {
  assert.throws(() => buildRewardSyncPlan({ testMode: true, rewards: [{ ...testReward, rewardCode: "REAL-001" }] }, existing), /test_reward_code_required/);
});

test("invalid payloads are rejected before producing updates", () => {
  assert.throws(() => buildRewardSyncPlan({}, existing), /rewards_required/);
  assert.throws(() => buildRewardSyncPlan({ rewards: [] }, existing), /rewards_required/);
  assert.throws(() => buildRewardSyncPlan({ rewards: [{ ...testReward, rewardCode: "" }] }, existing), /missing_reward_code/);
  assert.throws(() => buildRewardSyncPlan({ rewards: [{ ...testReward, stock: -1 }] }, existing), /invalid_stock/);
  assert.throws(() => buildRewardSyncPlan({ mode: "replace", rewards: [testReward] }, existing), /invalid_mode/);
});

test("duplicate reward codes in one payload are rejected", () => {
  assert.throws(() => buildRewardSyncPlan({ rewards: [testReward, testReward] }, existing), /duplicate_reward_code/);
});
