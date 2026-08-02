import { firebaseRead, toArray } from "./lib/firebase-rest.mjs";

const headers = { "Content-Type": "application/json; charset=utf-8" };
const json = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

function authorized(event) {
  const configured = process.env.SHEET_SYNC_SECRET;
  const supplied = event.headers["x-sheet-sync-secret"] || event.headers["X-Sheet-Sync-Secret"];
  return Boolean(configured && supplied === configured);
}

export async function handler(event) {
  if (event.httpMethod !== "GET") return json(405, { ok: false, status: "method_not_allowed" });
  if (!authorized(event)) return json(401, { ok: false, status: "unauthorized" });
  try {
    const [redemptionsRaw, customersRaw] = await Promise.all([firebaseRead("redemptions"), firebaseRead("customers")]);
    const customers = toArray(customersRaw.value);
    const customerById = new Map(customers.map((item) => [item.id, item]));
    const redemptions = toArray(redemptionsRaw.value).map((item) => {
      const customer = customerById.get(item.customerId) || {};
      return {
        id: item.id,
        customerId: item.customerId,
        phone: customer.phone || "",
        rewardId: item.rewardId,
        rewardName: item.rewardName,
        quantity: Number(item.quantity || 1),
        points: Number(item.points || 0),
        status: item.status,
        operator: item.operator || "",
        requestedAt: item.date || "",
        approvedAt: item.approvedAt || "",
        cancelledAt: item.refundedAt || "",
        refundTransactionId: item.refundTransactionId || "",
        note: item.note || ""
      };
    });
    return json(200, { ok: true, redemptions });
  } catch (error) {
    return json(500, { ok: false, status: "error", message: error.message });
  }
}
