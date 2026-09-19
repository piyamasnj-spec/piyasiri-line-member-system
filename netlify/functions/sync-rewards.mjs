import { sheetAuth } from "./lib/auth.mjs";
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Sheet-Sync-Secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8"
};
const json = (statusCode, body) => ({
  statusCode,
  headers,
  body: JSON.stringify(body)
});
const badRequest = message => Object.assign(new Error(message), {
  statusCode: 400
});
function normalizedNumber(value, field, {
  allowBlank = false,
  min = 0
} = {}) {
  if (allowBlank && value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) throw badRequest(`invalid_${field}`);
  return number;
}
function normalizeReward(item, testMode) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw badRequest("invalid_reward");
  const id = String(item.rewardCode || item.id || "").trim();
  if (!id) throw badRequest("missing_reward_code");
  if (testMode && !id.startsWith("TEST-")) throw badRequest("test_reward_code_required");
  return {
    id,
    name: String(item.name || "").trim(),
    cost: normalizedNumber(item.cost, "cost", {
      allowBlank: true
    }),
    points: normalizedNumber(item.points, "points"),
    stock: normalizedNumber(item.stock, "stock", {
      allowBlank: true
    }),
    active: item.active === true || item.active === "ใช่",
    description: String(item.note || item.description || "").trim(),
    recommendedPoints: normalizedNumber(item.recommendedPoints, "recommended_points", {
      allowBlank: true
    }),
    riskWarning: String(item.riskWarning || "").trim()
  };
}
function rewardEquals(previous, next) {
  return previous && ["id", "name", "cost", "points", "stock", "active", "description", "recommendedPoints", "riskWarning"].every(field => previous[field] === next[field]);
}
export function buildRewardSyncPlan(body, existing, now = new Date().toISOString()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("invalid_payload");
  const mode = body.mode === undefined || body.mode === "" ? "partial" : body.mode;
  if (mode !== "partial" && mode !== "full") throw badRequest("invalid_mode");
  if (!Array.isArray(body.rewards) || body.rewards.length === 0) throw badRequest("rewards_required");
  const testMode = body.testMode === true;
  const rewards = body.rewards.map(item => normalizeReward(item, testMode));
  const ids = new Set();
  for (const reward of rewards) {
    if (ids.has(reward.id)) throw badRequest("duplicate_reward_code");
    ids.add(reward.id);
  }
  const existingById = new Map(existing.map(item => [String(item.id || "").trim(), item]));
  const updates = {};
  let unchanged = 0;
  for (const reward of rewards) {
    const previous = existingById.get(reward.id);
    const next = {
      ...reward,
      imageUrl: previous?.imageUrl || ""
    };
    if (rewardEquals(previous, next) && (previous?.imageUrl || "") === next.imageUrl) {
      unchanged += 1;
    } else {
      updates[`rewards/${previous?.firebaseKey || reward.id}`] = {
        ...next,
        updatedAt: now
      };
    }
    existingById.delete(reward.id);
  }
  if (mode === "full") {
    for (const stale of existingById.values()) {
      if (stale.active !== false) updates[`rewards/${stale.firebaseKey || stale.id}/active`] = false;
    }
  }
  return {
    mode,
    testMode,
    rewards,
    updates,
    unchanged
  };
}
export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, {
    ok: false,
    status: "method_not_allowed"
  });
  try {
    sheetAuth(event);
    // STOP gate: an absolute stock snapshot can restore already reserved stock even
    // inside a transaction. Deployed Apps Script contract has not been verified.
    // Keep the legacy planner for reference/tests; do not guess a revision/delta contract.
    return json(503, {
      ok: false,
      status: "blocked_reward_stock_contract_review"
    });
  } catch (error) {
    console.error("sync-rewards: error", {
      type: error?.name || "Error"
    });
    return json(error.statusCode || 500, {
      ok: false,
      status: "error",
      message: error.message
    });
  }
}
