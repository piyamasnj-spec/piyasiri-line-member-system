import { randomUUID } from "node:crypto";
import { claimOperation, finishOperation, firebaseRead, firebaseRootPatch, toArray } from "./lib/firebase-rest.mjs";
import { normalizePhone, validateStoredPointResult } from "./lib/points.mjs";

const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Sheet-Sync-Secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8"
};

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function assertSecret(event) {
  const configured = process.env.SHEET_SYNC_SECRET;
  if (!configured) throw Object.assign(new Error("SHEET_SYNC_SECRET is not configured"), { statusCode: 503 });
  const supplied = event.headers["x-sheet-sync-secret"] || event.headers["X-Sheet-Sync-Secret"];
  if (supplied !== configured) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
}

function phoneVariants(value) {
  const phone = normalizePhone(value);
  const variants = new Set([phone]);
  if (phone.length === 9) variants.add(`0${phone}`);
  if (phone.startsWith("66") && phone.length === 11) variants.add(`0${phone.slice(2)}`);
  if (phone.startsWith("0") && phone.length === 10) {
    variants.add(phone.slice(1));
    variants.add(`66${phone.slice(1)}`);
  }
  return variants;
}

function findCustomer(customers, phone) {
  const requested = phoneVariants(phone);
  return customers.find((customer) => [...requested].some((candidate) => phoneVariants(customer.phone).has(candidate)));
}

function activeEarnForRef(transactions, ref) {
  const normalized = String(ref || "").trim().toLowerCase();
  return transactions.find((item) => {
    const activeStatus = !item.status || item.status === "confirmed";
    return item.type === "earn" && activeStatus && String(item.ref || "").trim().toLowerCase() === normalized;
  });
}

async function pushEarnNotification(customer, transaction) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || !customer.lineUserId) return { sent: false, reason: "missing-token-or-line-user-id" };
  const text = [
    `สวัสดี ${customer.name || "คุณลูกค้า"}`,
    `ร้านปิยสิริเคมีเกษตรเพิ่มคะแนนให้แล้ว +${transaction.points.toLocaleString("th-TH")} คะแนน`,
    `ยอดซื้อ: ${transaction.amount.toLocaleString("th-TH")} บาท`,
    `เลขบิล: ${transaction.ref}`,
    `คะแนนรวมปัจจุบัน: ${customer.points.toLocaleString("th-TH")} คะแนน`
  ].join("\n");
  const response = await fetch(LINE_PUSH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: customer.lineUserId, messages: [{ type: "text", text }] })
  });
  return response.ok ? { sent: true } : { sent: false, status: response.status };
}

async function loadState() {
  const [customersRaw, transactionsRaw] = await Promise.all([firebaseRead("customers"), firebaseRead("transactions")]);
  return { customers: toArray(customersRaw.value), transactions: toArray(transactionsRaw.value) };
}

async function confirmSale(body) {
  const ref = String(body.ref || "").trim();
  const phone = normalizePhone(body.phone);
  if (!ref) return json(400, { ok: false, status: "missing_ref" });
  if (!phone) return json(400, { ok: false, status: "missing_phone" });
  const result = validateStoredPointResult(body.pointResult);
  const claim = await claimOperation("sale-confirm", ref, { requestedBy: body.operator || "google-sheet" });
  if (!claim.claimed) return json(200, { ok: true, status: "duplicate", transactionId: claim.existing?.transactionId || "" });

  try {
    const { customers, transactions } = await loadState();
    const duplicate = activeEarnForRef(transactions, ref);
    if (duplicate) {
      await finishOperation(claim.key, { status: "duplicate", transactionId: duplicate.id });
      return json(200, { ok: true, status: "duplicate", transactionId: duplicate.id, points: duplicate.points });
    }
    const customer = findCustomer(customers, phone);
    if (!customer) throw Object.assign(new Error("customer not found"), { statusCode: 404, publicStatus: "customer_not_found" });

    const now = new Date().toISOString();
    const transactionId = body.transactionId || `sheet-${randomUUID()}`;
    const updatedPoints = Number(customer.points || 0) + result.points;
    const transaction = {
      id: transactionId,
      customerId: customer.id,
      type: "earn",
      status: "confirmed",
      amount: Number(result.amount || 0),
      points: result.points,
      pointBreakdown: result.breakdown,
      alerts: result.alerts || [],
      note: body.note || "บันทึกจาก Google Sheet ระบบร้าน",
      ref,
      source: "google-sheet",
      saleDate: body.saleDate || "",
      date: now,
      expiresAt: new Date(new Date(now).setMonth(new Date(now).getMonth() + 12)).toISOString()
    };
    const customerKey = customer.firebaseKey || customer.id;
    await firebaseRootPatch({
      [`customers/${customerKey}/points`]: updatedPoints,
      [`customers/${customerKey}/totalSpend`]: Number(customer.totalSpend || 0) + transaction.amount,
      [`transactions/${transactionId}`]: transaction
    });
    const updatedCustomer = { ...customer, points: updatedPoints };
    await finishOperation(claim.key, { status: "completed", transactionId });
    const notification = await pushEarnNotification(updatedCustomer, transaction);
    return json(200, { ok: true, status: "synced", customerId: customer.id, points: result.points, totalPoints: updatedPoints, transactionId, notification });
  } catch (error) {
    await finishOperation(claim.key, { status: "failed", error: error.message });
    throw error;
  }
}

async function reverseSale(body) {
  const ref = String(body.ref || "").trim();
  if (!ref) return json(400, { ok: false, status: "missing_ref" });
  const claim = await claimOperation("sale-reverse", ref, { requestedBy: body.operator || "google-sheet" });
  if (!claim.claimed) return json(200, { ok: true, status: "duplicate_reverse", transactionId: claim.existing?.transactionId || "" });
  try {
    const { customers, transactions } = await loadState();
    const original = activeEarnForRef(transactions, ref);
    if (!original) throw Object.assign(new Error("active bill transaction not found"), { statusCode: 404, publicStatus: "transaction_not_found" });
    const customer = customers.find((item) => item.id === original.customerId);
    if (!customer) throw Object.assign(new Error("customer not found"), { statusCode: 404, publicStatus: "customer_not_found" });
    const reversalId = body.transactionId || `reverse-${randomUUID()}`;
    const now = new Date().toISOString();
    const updatedPoints = Number(customer.points || 0) - Number(original.points || 0);
    const customerKey = customer.firebaseKey || customer.id;
    await firebaseRootPatch({
      [`customers/${customerKey}/points`]: updatedPoints,
      [`customers/${customerKey}/totalSpend`]: Math.max(0, Number(customer.totalSpend || 0) - Number(original.amount || 0)),
      [`transactions/${original.firebaseKey || original.id}/status`]: "reversed",
      [`transactions/${original.firebaseKey || original.id}/reversedAt`]: now,
      [`transactions/${original.firebaseKey || original.id}/reversalTransactionId`]: reversalId,
      [`transactions/${reversalId}`]: { id: reversalId, customerId: customer.id, type: "sale_reversal", status: "confirmed", points: Number(original.points || 0), amount: Number(original.amount || 0), ref, originalTransactionId: original.id, date: now, operator: body.operator || "google-sheet" }
    });
    await finishOperation(claim.key, { status: "completed", transactionId: reversalId });
    return json(200, { ok: true, status: "reversed", points: Number(original.points || 0), totalPoints: updatedPoints, transactionId: reversalId, originalTransactionId: original.id });
  } catch (error) {
    await finishOperation(claim.key, { status: "failed", error: error.message });
    throw error;
  }
}

async function recalculateSale(body) {
  const ref = String(body.ref || "").trim();
  const operationId = String(body.operationId || "").trim();
  if (!ref || !operationId) return json(400, { ok: false, status: "missing_ref_or_operation_id" });
  const result = validateStoredPointResult(body.pointResult);
  const claim = await claimOperation("sale-recalculate", `${ref}:${operationId}`, { requestedBy: body.operator || "google-sheet" });
  if (!claim.claimed) return json(200, { ok: true, status: "duplicate_recalculation", transactionId: claim.existing?.transactionId || "" });
  try {
    const { customers, transactions } = await loadState();
    const original = activeEarnForRef(transactions, ref);
    if (!original) throw Object.assign(new Error("active bill transaction not found"), { statusCode: 404, publicStatus: "transaction_not_found" });
    const customer = customers.find((item) => item.id === original.customerId);
    if (!customer) throw Object.assign(new Error("customer not found"), { statusCode: 404, publicStatus: "customer_not_found" });
    const transactionId = body.transactionId || `recalc-${randomUUID()}`;
    const now = new Date().toISOString();
    const deltaPoints = result.points - Number(original.points || 0);
    const deltaAmount = Number(result.amount || 0) - Number(original.amount || 0);
    const updatedPoints = Number(customer.points || 0) + deltaPoints;
    const customerKey = customer.firebaseKey || customer.id;
    const transaction = { id: transactionId, customerId: customer.id, type: "earn", status: "confirmed", amount: result.amount, points: result.points, pointBreakdown: result.breakdown, alerts: result.alerts || [], ref, source: "google-sheet", previousTransactionId: original.id, date: now, operator: body.operator || "google-sheet" };
    await firebaseRootPatch({
      [`customers/${customerKey}/points`]: updatedPoints,
      [`customers/${customerKey}/totalSpend`]: Math.max(0, Number(customer.totalSpend || 0) + deltaAmount),
      [`transactions/${original.firebaseKey || original.id}/status`]: "revised",
      [`transactions/${original.firebaseKey || original.id}/revisedAt`]: now,
      [`transactions/${original.firebaseKey || original.id}/replacementTransactionId`]: transactionId,
      [`transactions/${transactionId}`]: transaction
    });
    await finishOperation(claim.key, { status: "completed", transactionId });
    return json(200, { ok: true, status: "recalculated", customerId: customer.id, points: result.points, deltaPoints, totalPoints: updatedPoints, transactionId, originalTransactionId: original.id });
  } catch (error) {
    await finishOperation(claim.key, { status: "failed", error: error.message });
    throw error;
  }
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod === "GET") return json(200, { ok: true, service: "sync-sale-points", version: 2 });
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });
  try {
    assertSecret(event);
    const body = JSON.parse(event.body || "{}");
    const action = body.action || "confirm";
    if (action === "confirm") return await confirmSale(body);
    if (action === "reverse") return await reverseSale(body);
    if (action === "recalculate") return await recalculateSale(body);
    return json(400, { ok: false, status: "unknown_action" });
  } catch (error) {
    console.error("sync-sale-points failed", error);
    return json(error.statusCode || 500, { ok: false, status: error.publicStatus || (error.statusCode === 401 ? "unauthorized" : "error"), message: error.message || "sync failed" });
  }
}
