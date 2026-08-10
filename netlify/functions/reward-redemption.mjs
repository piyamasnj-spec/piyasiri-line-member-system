import { randomUUID } from "node:crypto";
import { claimOperation, finishOperation, firebaseRead, firebaseRootPatch, toArray } from "./lib/firebase-rest.mjs";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Sheet-Sync-Secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8"
};
const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const testId = (value) => String(value || "").trim().startsWith("TEST-");

function assertTestSecret(event) {
  const configured = process.env.SHEET_SYNC_SECRET;
  const supplied = event.headers?.["x-sheet-sync-secret"] || event.headers?.["X-Sheet-Sync-Secret"];
  if (!configured || supplied !== configured) throw httpError(401, "unauthorized");
}

function validateTestRequest(body) {
  const action = body.action || "request";
  const memberId = String(body.memberId || body.customerId || "").trim();
  const rewardId = String(body.rewardId || "").trim();
  const redemptionId = String(body.redemptionId || "").trim();
  if (!testId(redemptionId)) throw httpError(400, "test_redemption_id_required");
  if (action === "request") {
    if (!testId(memberId)) throw httpError(400, "test_member_id_required");
    if (!testId(rewardId)) throw httpError(400, "test_reward_id_required");
  }
  return { memberId, rewardId, redemptionId };
}

export function createRewardRedemptionHandler(dependencies = {}) {
  const read = dependencies.firebaseRead || firebaseRead;
  const patch = dependencies.firebaseRootPatch || firebaseRootPatch;
  const claim = dependencies.claimOperation || claimOperation;
  const finish = dependencies.finishOperation || finishOperation;
  const uuid = dependencies.randomUUID || randomUUID;
  const now = dependencies.now || (() => new Date().toISOString());

  async function requestRedemption(body) {
    const testMode = body.testMode === true;
    const customerId = String(body.memberId || body.customerId || "").trim();
    const rewardId = String(body.rewardId || "").trim();
    const requestedRedemptionId = String(body.redemptionId || "").trim();
    const operationId = String(body.operationId || requestedRedemptionId || "").trim();
    if (!operationId || !customerId || !rewardId) return json(400, { ok: false, status: "missing_required_fields" });

    const redemptionId = testMode ? requestedRedemptionId : `redeem-${uuid()}`;
    const operationReference = testMode ? redemptionId : operationId;
    if (testMode && (await read(`redemptions/${redemptionId}`)).value) {
      return json(200, { ok: true, status: "duplicate", redemptionId });
    }
    const operation = await claim("reward-request", operationReference, { customerId, rewardId, redemptionId, testMode });
    if (!operation.claimed) {
      return json(200, { ok: true, status: "duplicate", redemptionId: operation.existing?.redemptionId || redemptionId });
    }

    try {
      const [customersRaw, rewardsRaw] = await Promise.all([read("customers"), read("rewards")]);

      const customer = toArray(customersRaw.value).find((item) => item.id === customerId);
      const reward = toArray(rewardsRaw.value).find((item) => item.id === rewardId);
      if (!customer) throw httpError(404, "customer not found");
      if (!reward || (testMode ? reward.active !== true : reward.active === false)) throw httpError(409, "reward unavailable");

      const quantity = Number(body.quantity || 1);
      if (!Number.isInteger(quantity) || quantity < 1) throw httpError(400, "invalid quantity");
      const pointsUsed = Number(reward.points || 0) * quantity;
      const finiteStock = reward.stock !== "" && reward.stock !== null && reward.stock !== undefined;
      const stockBefore = finiteStock ? Number(reward.stock) : null;
      const pointsBefore = Number(customer.points || 0);
      if (!Number.isFinite(pointsUsed) || pointsUsed <= 0) throw httpError(409, "invalid reward points");
      if (pointsBefore < pointsUsed) throw httpError(409, "insufficient points");
      if (finiteStock && (!Number.isFinite(stockBefore) || stockBefore < quantity)) throw httpError(409, "out of stock");

      const createdAt = now();
      const transactionId = testMode ? `TEST-POINTS-${uuid()}` : `redeem-points-${uuid()}`;
      const customerKey = customer.firebaseKey || customer.id;
      const rewardKey = reward.firebaseKey || reward.id;
      const operator = String(body.operator || (testMode ? "TEST-OPERATOR" : "admin"));
      const stockAfter = finiteStock ? stockBefore - quantity : "";
      const redemption = testMode
        ? {
            id: redemptionId,
            memberId: customer.id,
            customerId: customer.id,
            rewardId: reward.id,
            rewardName: reward.name,
            pointsUsed,
            points: pointsUsed,
            quantity,
            stockBefore,
            stockAfter,
            stockChange: finiteStock ? -quantity : "",
            operator,
            transactionId,
            createdAt,
            date: createdAt,
            status: "requested",
            operationId,
            testMode: true
          }
        : { id: redemptionId, customerId: customer.id, rewardId: reward.id, rewardName: reward.name, quantity, points: pointsUsed, transactionId, date: createdAt, status: "requested", operationId };
      const updates = {
        [`customers/${customerKey}/points`]: pointsBefore - pointsUsed,
        [`redemptions/${redemptionId}`]: redemption,
        [`transactions/${transactionId}`]: { id: transactionId, customerId: customer.id, type: "redeem", status: "confirmed", points: pointsUsed, amount: 0, rewardId: reward.id, redemptionId, date: createdAt }
      };
      if (finiteStock) updates[`rewards/${rewardKey}/stock`] = stockAfter;
      await patch(updates);
      await finish(operation.key, { status: "completed", redemptionId, transactionId });
      return json(200, { ok: true, status: "requested", redemptionId, transactionId, points: pointsUsed, totalPoints: pointsBefore - pointsUsed, stock: stockAfter });
    } catch (error) {
      await finish(operation.key, { status: "failed", error: error.message });
      throw error;
    }
  }

  async function updateRedemption(body) {
    const action = body.action;
    const testMode = body.testMode === true;
    const redemptionId = String(body.redemptionId || "").trim();
    if (!redemptionId) return json(400, { ok: false, status: "missing_redemption_id" });
    const operator = String(body.operator || (testMode ? "TEST-OPERATOR" : "admin"));
    let validatedTestRedemption = null;
    if (testMode) {
      validatedTestRedemption = (await read(`redemptions/${redemptionId}`)).value;
      if (!validatedTestRedemption) throw httpError(404, "redemption not found");
      const storedMemberId = String(validatedTestRedemption.memberId || validatedTestRedemption.customerId || "").trim();
      const storedRewardId = String(validatedTestRedemption.rewardId || "").trim();
      if (validatedTestRedemption.testMode !== true || !testId(storedMemberId) || !testId(storedRewardId)) throw httpError(400, "test_redemption_data_required");
    }
    const operation = await claim(`reward-${action}`, redemptionId, { operator, testMode });
    if (!operation.claimed) return json(200, { ok: true, status: `duplicate_${action}`, redemptionId });

    try {
      const reads = testMode ? [read("customers"), read("rewards")] : [read(`redemptions/${redemptionId}`), read("customers"), read("rewards")];
      const results = await Promise.all(reads);
      const redemption = testMode ? validatedTestRedemption : results[0].value;
      const customersRaw = testMode ? results[0] : results[1];
      const rewardsRaw = testMode ? results[1] : results[2];
      if (!redemption) throw httpError(404, "redemption not found");
      if (redemption.status === "cancelled" || (action === "complete" && redemption.status === "completed")) {
        await finish(operation.key, { status: "duplicate", redemptionId });
        return json(200, { ok: true, status: "already_final", redemptionId, currentStatus: redemption.status });
      }

      const changedAt = now();
      if (action === "complete") {
        await patch({ [`redemptions/${redemptionId}/status`]: "completed", [`redemptions/${redemptionId}/approvedAt`]: changedAt, [`redemptions/${redemptionId}/operator`]: operator });
        await finish(operation.key, { status: "completed", redemptionId });
        return json(200, { ok: true, status: "completed", redemptionId });
      }

      const storedCustomerId = String(redemption.memberId || redemption.customerId || "").trim();
      const customer = toArray(customersRaw.value).find((item) => item.id === storedCustomerId);
      const reward = toArray(rewardsRaw.value).find((item) => item.id === redemption.rewardId);
      if (!customer || !reward) throw httpError(409, "redemption references missing data");
      const pointsUsed = Number(testMode ? redemption.pointsUsed : redemption.points || 0);
      const quantity = Number(redemption.quantity || 1);
      if (!Number.isFinite(pointsUsed) || pointsUsed <= 0 || !Number.isInteger(quantity) || quantity < 1) throw httpError(409, "invalid redemption snapshot");

      const refundId = testMode ? `TEST-REFUND-${uuid()}` : `redeem-refund-${uuid()}`;
      const customerKey = customer.firebaseKey || customer.id;
      const rewardKey = reward.firebaseKey || reward.id;
      const finiteStock = reward.stock !== "" && reward.stock !== null && reward.stock !== undefined;
      const updates = {
        [`customers/${customerKey}/points`]: Number(customer.points || 0) + pointsUsed,
        [`redemptions/${redemptionId}/status`]: "cancelled",
        [`redemptions/${redemptionId}/cancelledAt`]: changedAt,
        [`redemptions/${redemptionId}/refundedAt`]: changedAt,
        [`redemptions/${redemptionId}/refundTransactionId`]: refundId,
        [`redemptions/${redemptionId}/operator`]: operator,
        [`transactions/${refundId}`]: { id: refundId, customerId: customer.id, type: "refund", status: "confirmed", points: pointsUsed, amount: 0, rewardId: reward.id, redemptionId, date: changedAt }
      };
      if (finiteStock) updates[`rewards/${rewardKey}/stock`] = Number(reward.stock || 0) + quantity;
      await patch(updates);
      await finish(operation.key, { status: "completed", redemptionId, transactionId: refundId });
      return json(200, { ok: true, status: "cancelled", redemptionId, transactionId: refundId, totalPoints: Number(customer.points || 0) + pointsUsed });
    } catch (error) {
      await finish(operation.key, { status: "failed", error: error.message });
      throw error;
    }
  }

  return async function handler(event) {
    if (event.httpMethod === "OPTIONS") return json(204, {});
    if (event.httpMethod !== "POST") return json(405, { ok: false, status: "method_not_allowed" });
    try {
      const body = JSON.parse(event.body || "{}");
      if (body.testMode === true) {
        assertTestSecret(event);
        validateTestRequest(body);
      }
      if ((body.action || "request") === "request") return await requestRedemption(body);
      if (body.action === "complete" || body.action === "cancel") return await updateRedemption(body);
      return json(400, { ok: false, status: "unknown_action" });
    } catch (error) {
      console.error("reward-redemption failed", { type: error?.name || "Error" });
      return json(error.statusCode || 500, { ok: false, status: "error", message: error.message || "reward operation failed" });
    }
  };
}

export const handler = createRewardRedemptionHandler();
