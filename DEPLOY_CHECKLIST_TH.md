const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
const DEFAULT_DATABASE_URL = "https://piyasiri-member-system-default-rtdb.asia-southeast1.firebasedatabase.app";
const EXPIRY_WINDOW_DAYS = 30;

function databaseUrl() {
  return (process.env.FIREBASE_DATABASE_URL || DEFAULT_DATABASE_URL).replace(/\/$/, "");
}

function toArray(value) {
  return Object.entries(value || {}).map(([id, item]) => ({ id, ...item }));
}

function formatDate(value) {
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeZone: "Asia/Bangkok" }).format(new Date(value));
}

function money(value) {
  return Number(value || 0).toLocaleString("th-TH");
}

function expiryText(customer, transaction) {
  return [
    `สวัสดี ${customer.name || "คุณลูกค้า"}`,
    `แจ้งเตือนแต้มใกล้หมดอายุ`,
    `${money(transaction.points)} แต้ม จะหมดอายุวันที่ ${formatDate(transaction.expiresAt)}`,
    `แต้มรวมปัจจุบัน: ${money(customer.points)} แต้ม`,
    `สามารถเข้ามาแลกของรางวัลได้ใน LINE OA ของร้าน`
  ].join("\n");
}

async function loadCollection(name) {
  const response = await fetch(`${databaseUrl()}/${name}.json`);
  if (!response.ok) throw new Error(`Firebase load failed: ${name}`);
  return toArray(await response.json());
}

async function patchTransaction(id, updates) {
  const response = await fetch(`${databaseUrl()}/transactions/${id}.json`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates)
  });
  if (!response.ok) throw new Error(`Firebase update failed: ${id}`);
}

async function pushLineMessage(to, text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("missing LINE_CHANNEL_ACCESS_TOKEN");
  const response = await fetch(LINE_PUSH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text }]
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE push failed: ${response.status} ${body}`);
  }
}

export default async function handler() {
  const now = Date.now();
  const end = now + EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const [customers, transactions] = await Promise.all([
    loadCollection("customers"),
    loadCollection("transactions")
  ]);
  const customersById = new Map(customers.map(customer => [customer.id, customer]));
  const targets = transactions.filter(transaction => {
    if (transaction.type !== "earn" || !transaction.expiresAt || transaction.expiryNotifiedAt) return false;
    const expiry = new Date(transaction.expiresAt).getTime();
    return expiry >= now && expiry <= end;
  });

  let sent = 0;
  for (const transaction of targets) {
    const customer = customersById.get(transaction.customerId);
    if (!customer?.lineUserId) continue;
    await pushLineMessage(customer.lineUserId, expiryText(customer, transaction));
    await patchTransaction(transaction.id, {
      expiryNotifiedAt: new Date().toISOString(),
      expiryNotificationStatus: "sent"
    });
    sent += 1;
  }

  console.log(`Expiring point notifications sent: ${sent}`);
  return new Response(JSON.stringify({ ok: true, sent }), {
    headers: { "Content-Type": "application/json" }
  });
}

export const config = {
  schedule: "@daily"
};
