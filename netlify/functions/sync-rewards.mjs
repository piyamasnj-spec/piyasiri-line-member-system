import { firebaseRead, firebaseRootPatch, toArray } from "./lib/firebase-rest.mjs";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-Sheet-Sync-Secret", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json; charset=utf-8" };
const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

function assertSecret(event) {
  const configured = process.env.SHEET_SYNC_SECRET;
  const supplied = event.headers["x-sheet-sync-secret"] || event.headers["X-Sheet-Sync-Secret"];
  if (!configured || supplied !== configured) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { ok: false, status: "method_not_allowed" });
  try {
    assertSecret(event);
    const body = JSON.parse(event.body || "{}");
    if (!Array.isArray(body.rewards)) return json(400, { ok: false, status: "missing_rewards" });
    const existing = toArray((await firebaseRead("rewards")).value);
    const existingById = new Map(existing.map((item) => [item.id, item]));
    const updates = {};
    for (const item of body.rewards) {
      const id = String(item.id || "").trim();
      if (!id) continue;
      const previous = existingById.get(id);
      updates[`rewards/${previous?.firebaseKey || id}`] = {
        id,
        name: String(item.name || "").trim(),
        cost: item.cost === "" ? "" : Number(item.cost),
        points: Number(item.points || 0),
        stock: item.stock === "" ? "" : Number(item.stock),
        active: item.active === true || item.active === "ใช่",
        description: String(item.note || "").trim(),
        recommendedPoints: item.recommendedPoints === "" ? "" : Number(item.recommendedPoints),
        riskWarning: String(item.riskWarning || "").trim(),
        imageUrl: previous?.imageUrl || "",
        updatedAt: new Date().toISOString()
      };
      existingById.delete(id);
    }
    for (const stale of existingById.values()) updates[`rewards/${stale.firebaseKey || stale.id}/active`] = false;
    await firebaseRootPatch(updates);
    return json(200, { ok: true, status: "synced", count: body.rewards.length });
  } catch (error) {
    return json(error.statusCode || 500, { ok: false, status: "error", message: error.message });
  }
}
