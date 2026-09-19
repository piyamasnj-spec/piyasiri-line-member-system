import { firebaseRead, toArray } from "./lib/firebase-rest.mjs";
import { sheetAuth } from "./lib/auth.mjs";
const headers = {
  "Content-Type": "application/json; charset=utf-8"
};
const json = (statusCode, body) => ({
  statusCode,
  headers,
  body: JSON.stringify(body)
});
export async function handler(event) {
  if (event.httpMethod !== "GET") return json(405, {
    ok: false,
    status: "method_not_allowed"
  });
  try {
    sheetAuth(event);
  } catch {
    return json(401, {
      ok: false,
      status: "unauthorized"
    });
  }
  try {
    const root = (await firebaseRead("")).value || {};
    const customers = toArray(root.customers);
    const customerById = new Map(customers.map(item => [item.id, item]));
    const redemptions = toArray(root.redemptions).map(item => {
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
    return json(200, {
      ok: true,
      redemptions
    });
  } catch (error) {
    return json(503, {
      ok: false,
      status: "service_unavailable"
    });
  }
}
