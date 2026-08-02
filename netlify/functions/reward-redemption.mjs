import { randomUUID } from "node:crypto";
import { claimOperation, finishOperation, firebaseRead, firebaseRootPatch, toArray } from "./lib/firebase-rest.mjs";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json; charset=utf-8" };
const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

async function requestRedemption(body) {
  const operationId = String(body.operationId || "").trim();
  if (!operationId || !body.customerId || !body.rewardId) return json(400, { ok: false, status: "missing_required_fields" });
  const claim = await claimOperation("reward-request", operationId, { customerId: body.customerId, rewardId: body.rewardId });
  if (!claim.claimed) return json(200, { ok: true, status: "duplicate", redemptionId: claim.existing?.redemptionId || "" });
  try {
    const [customersRaw, rewardsRaw] = await Promise.all([firebaseRead("customers"), firebaseRead("rewards")]);
    const customer = toArray(customersRaw.value).find((item) => item.id === body.customerId);
    const reward = toArray(rewardsRaw.value).find((item) => item.id === body.rewardId);
    if (!customer) throw Object.assign(new Error("customer not found"), { statusCode: 404 });
    if (!reward || reward.active === false) throw Object.assign(new Error("reward unavailable"), { statusCode: 409 });
    const quantity = Math.max(1, Number(body.quantity || 1));
    const points = Number(reward.points || 0) * quantity;
    const finiteStock = reward.stock !== "" && reward.stock !== null && reward.stock !== undefined;
    const currentStock = finiteStock ? Number(reward.stock) : null;
    if (!Number.isFinite(points) || points <= 0) throw Object.assign(new Error("invalid reward points"), { statusCode: 409 });
    if (Number(customer.points || 0) < points) throw Object.assign(new Error("insufficient points"), { statusCode: 409 });
    if (finiteStock && (!Number.isFinite(currentStock) || currentStock < quantity)) throw Object.assign(new Error("out of stock"), { statusCode: 409 });

    const now = new Date().toISOString();
    const redemptionId = `redeem-${randomUUID()}`;
    const transactionId = `redeem-points-${randomUUID()}`;
    const customerKey = customer.firebaseKey || customer.id;
    const rewardKey = reward.firebaseKey || reward.id;
    const redemption = { id: redemptionId, customerId: customer.id, rewardId: reward.id, rewardName: reward.name, quantity, points, transactionId, date: now, status: "requested", operationId };
    const updates = {
      [`customers/${customerKey}/points`]: Number(customer.points || 0) - points,
      [`redemptions/${redemptionId}`]: redemption,
      [`transactions/${transactionId}`]: { id: transactionId, customerId: customer.id, type: "redeem", status: "confirmed", points, amount: 0, rewardId: reward.id, redemptionId, date: now }
    };
    if (finiteStock) updates[`rewards/${rewardKey}/stock`] = currentStock - quantity;
    await firebaseRootPatch(updates);
    await finishOperation(claim.key, { status: "completed", redemptionId, transactionId });
    return json(200, { ok: true, status: "requested", redemptionId, transactionId, points, totalPoints: Number(customer.points || 0) - points, stock: finiteStock ? currentStock - quantity : "" });
  } catch (error) {
    await finishOperation(claim.key, { status: "failed", error: error.message });
    throw error;
  }
}

async function updateRedemption(body) {
  const action = body.action;
  const redemptionId = String(body.redemptionId || "").trim();
  if (!redemptionId) return json(400, { ok: false, status: "missing_redemption_id" });
  const claim = await claimOperation(`reward-${action}`, redemptionId, { operator: body.operator || "admin" });
  if (!claim.claimed) return json(200, { ok: true, status: `duplicate_${action}`, redemptionId });
  try {
    const [redemptionRaw, customersRaw, rewardsRaw] = await Promise.all([firebaseRead(`redemptions/${redemptionId}`), firebaseRead("customers"), firebaseRead("rewards")]);
    const redemption = redemptionRaw.value;
    if (!redemption) throw Object.assign(new Error("redemption not found"), { statusCode: 404 });
    if (redemption.status === "cancelled" || (action === "complete" && redemption.status === "completed")) {
      await finishOperation(claim.key, { status: "duplicate", redemptionId });
      return json(200, { ok: true, status: "already_final", redemptionId, currentStatus: redemption.status });
    }
    const now = new Date().toISOString();
    if (action === "complete") {
      await firebaseRootPatch({ [`redemptions/${redemptionId}/status`]: "completed", [`redemptions/${redemptionId}/approvedAt`]: now, [`redemptions/${redemptionId}/operator`]: body.operator || "admin" });
      await finishOperation(claim.key, { status: "completed", redemptionId });
      return json(200, { ok: true, status: "completed", redemptionId });
    }

    const customer = toArray(customersRaw.value).find((item) => item.id === redemption.customerId);
    const reward = toArray(rewardsRaw.value).find((item) => item.id === redemption.rewardId);
    if (!customer || !reward) throw Object.assign(new Error("redemption references missing data"), { statusCode: 409 });
    const refundId = `redeem-refund-${randomUUID()}`;
    const customerKey = customer.firebaseKey || customer.id;
    const rewardKey = reward.firebaseKey || reward.id;
    const finiteStock = reward.stock !== "" && reward.stock !== null && reward.stock !== undefined;
    const updates = {
      [`customers/${customerKey}/points`]: Number(customer.points || 0) + Number(redemption.points || 0),
      [`redemptions/${redemptionId}/status`]: "cancelled",
      [`redemptions/${redemptionId}/refundedAt`]: now,
      [`redemptions/${redemptionId}/refundTransactionId`]: refundId,
      [`redemptions/${redemptionId}/operator`]: body.operator || "admin",
      [`transactions/${refundId}`]: { id: refundId, customerId: customer.id, type: "refund", status: "confirmed", points: Number(redemption.points || 0), amount: 0, rewardId: reward.id, redemptionId, date: now }
    };
    if (finiteStock) updates[`rewards/${rewardKey}/stock`] = Number(reward.stock || 0) + Number(redemption.quantity || 1);
    await firebaseRootPatch(updates);
    await finishOperation(claim.key, { status: "completed", redemptionId, transactionId: refundId });
    return json(200, { ok: true, status: "cancelled", redemptionId, transactionId: refundId, totalPoints: Number(customer.points || 0) + Number(redemption.points || 0) });
  } catch (error) {
    await finishOperation(claim.key, { status: "failed", error: error.message });
    throw error;
  }
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { ok: false, status: "method_not_allowed" });
  try {
    const body = JSON.parse(event.body || "{}");
    if ((body.action || "request") === "request") return await requestRedemption(body);
    if (body.action === "complete" || body.action === "cancel") return await updateRedemption(body);
    return json(400, { ok: false, status: "unknown_action" });
  } catch (error) {
    console.error("reward-redemption failed", error);
    return json(error.statusCode || 500, { ok: false, status: "error", message: error.message || "reward operation failed" });
  }
}
