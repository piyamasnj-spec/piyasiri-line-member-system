const DEFAULT_DATABASE_URL = "https://piyasiri-member-system-default-rtdb.asia-southeast1.firebasedatabase.app";
const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
const POINT_RATE = 100;

const responseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Sheet-Sync-Secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8"
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: responseHeaders,
    body: JSON.stringify(body)
  };
}

function databaseUrl() {
  return (process.env.FIREBASE_DATABASE_URL || DEFAULT_DATABASE_URL).replace(/\/$/, "");
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function toArray(value) {
  return Object.entries(value || {}).map(([key, item]) => ({
    ...item,
    id: item?.id || key,
    firebaseKey: key
  }));
}

function addMonths(value, months) {
  const date = new Date(value);
  date.setMonth(date.getMonth() + months);
  return date.toISOString();
}

function money(value) {
  return Number(value || 0).toLocaleString("th-TH");
}

async function firebaseRead(path) {
  const response = await fetch(`${databaseUrl()}/${path}.json`);
  if (!response.ok) throw new Error(`Firebase read failed: ${path}`);
  return response.json();
}

async function firebasePatch(path, value) {
  const response = await fetch(`${databaseUrl()}/${path}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value)
  });
  if (!response.ok) throw new Error(`Firebase patch failed: ${path}`);
}

async function firebasePut(path, value) {
  const response = await fetch(`${databaseUrl()}/${path}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value)
  });
  if (!response.ok) throw new Error(`Firebase put failed: ${path}`);
}

async function pushLineMessage(customer, transaction) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || !customer.lineUserId) return { sent: false, reason: "missing-token-or-line-user-id" };

  const text = [
    `สวัสดี ${customer.name || "คุณลูกค้า"}`,
    `ร้านปิยสิริเคมีเกษตรเพิ่มแต้มให้แล้ว +${money(transaction.points)} แต้ม`,
    `ยอดซื้อ: ${money(transaction.amount)} บาท`,
    transaction.ref ? `เลขบิล/อ้างอิง: ${transaction.ref}` : "",
    `แต้มรวมปัจจุบัน: ${money(customer.points)} แต้ม`
  ].filter(Boolean).join("\n");

  const response = await fetch(LINE_PUSH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      to: customer.lineUserId,
      messages: [{ type: "text", text }]
    })
  });

  if (!response.ok) {
    return { sent: false, status: response.status, detail: await response.text() };
  }
  return { sent: true };
}

function assertSecret(event) {
  const configuredSecret = process.env.SHEET_SYNC_SECRET;
  if (!configuredSecret) return;
  const headerSecret = event.headers["x-sheet-sync-secret"] || event.headers["X-Sheet-Sync-Secret"];
  if (headerSecret !== configuredSecret) {
    const error = new Error("unauthorized");
    error.statusCode = 401;
    throw error;
  }
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod === "GET") return json(200, { ok: true, service: "sync-sale-points" });
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });

  try {
    assertSecret(event);

    const body = JSON.parse(event.body || "{}");
    const phone = normalizePhone(body.phone);
    const amount = Math.max(0, Number(body.amount || 0));
    const points = Math.floor(amount / POINT_RATE);
    const ref = String(body.ref || "").trim();

    if (!phone) return json(400, { ok: false, status: "missing_phone", message: "missing phone" });
    if (!amount) return json(400, { ok: false, status: "missing_amount", message: "missing amount" });
    if (points <= 0) return json(200, { ok: true, status: "skipped", message: "amount below point rate", points: 0 });

    const [customersRaw, transactionsRaw] = await Promise.all([
      firebaseRead("customers"),
      firebaseRead("transactions")
    ]);

    const customers = toArray(customersRaw);
    const transactions = toArray(transactionsRaw);
    const customer = customers.find(item => normalizePhone(item.phone) === phone);

    if (!customer) {
      return json(404, { ok: false, status: "customer_not_found", message: "customer not found" });
    }

    if (ref) {
      const duplicate = transactions.find(item => String(item.ref || "").trim().toLowerCase() === ref.toLowerCase());
      if (duplicate) {
        return json(200, { ok: true, status: "duplicate", message: "already synced", transactionId: duplicate.id });
      }
    }

    const now = new Date().toISOString();
    const transactionId = `sheet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const updatedCustomer = {
      ...customer,
      points: Number(customer.points || 0) + points,
      totalSpend: Number(customer.totalSpend || 0) + amount
    };
    delete updatedCustomer.firebaseKey;

    const transaction = {
      id: transactionId,
      customerId: customer.id,
      type: "earn",
      amount,
      points,
      note: body.note || "บันทึกจาก Google Sheet ระบบร้าน",
      ref,
      source: "google-sheet",
      saleDate: body.saleDate || "",
      date: now,
      expiresAt: addMonths(now, 12)
    };

    const customerKey = customer.firebaseKey || customer.id;
    await Promise.all([
      firebasePatch(`customers/${customerKey}`, {
        points: updatedCustomer.points,
        totalSpend: updatedCustomer.totalSpend
      }),
      firebasePut(`transactions/${transactionId}`, transaction)
    ]);

    const notification = await pushLineMessage(updatedCustomer, transaction);

    return json(200, {
      ok: true,
      status: "synced",
      customerId: customer.id,
      customerName: customer.name || "",
      points,
      totalPoints: updatedCustomer.points,
      transactionId,
      notification
    });
  } catch (error) {
    console.error("sync-sale-points failed", error);
    return json(error.statusCode || 500, {
      ok: false,
      status: error.statusCode === 401 ? "unauthorized" : "error",
      message: error.message || "sync failed"
    });
  }
}
