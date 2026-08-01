const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";

const responseHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8"
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: responseHeaders,
    body: JSON.stringify(body)
  };
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeZone: "Asia/Bangkok"
  }).format(new Date(value));
}

function money(value) {
  return Number(value || 0).toLocaleString("th-TH");
}

function buildText(type, payload = {}) {
  const name = payload.customerName || "คุณลูกค้า";

  if (type === "approved_points") {
    return [
      `สวัสดี ${name}`,
      `ร้านปิยสิริเคมีเกษตรอนุมัติแต้มให้แล้ว +${money(payload.points)} แต้ม`,
      `ยอดซื้อที่อนุมัติ: ${money(payload.amount)} บาท`,
      payload.ref ? `เลขบิล/อ้างอิง: ${payload.ref}` : "",
      `แต้มรวมปัจจุบัน: ${money(payload.totalPoints)} แต้ม`,
      `แต้มชุดนี้หมดอายุ: ${formatDate(payload.expiresAt)}`
    ].filter(Boolean).join("\n");
  }

  if (type === "redeem_completed") {
    return [
      `สวัสดี ${name}`,
      "ร้านจัดการคำขอแลกของเรียบร้อยแล้ว",
      `รายการ: ${payload.rewardName || "-"}`,
      `ใช้แต้ม: ${money(payload.points)} แต้ม`,
      `แต้มคงเหลือ: ${money(payload.totalPoints)} แต้ม`
    ].join("\n");
  }

  if (type === "redeem_cancelled") {
    return [
      `สวัสดี ${name}`,
      "คำขอแลกของของคุณถูกยกเลิกแล้ว",
      `รายการ: ${payload.rewardName || "-"}`,
      `ระบบคืนแต้มให้แล้ว ${money(payload.points)} แต้ม`,
      `แต้มรวมปัจจุบัน: ${money(payload.totalPoints)} แต้ม`
    ].join("\n");
  }

  if (type === "points_expiring") {
    return [
      `สวัสดี ${name}`,
      "แจ้งเตือนแต้มใกล้หมดอายุ",
      `${money(payload.points)} แต้ม จะหมดอายุวันที่ ${formatDate(payload.expiresAt)}`,
      `แต้มรวมปัจจุบัน: ${money(payload.totalPoints)} แต้ม`,
      "สามารถเข้ามาแลกของรางวัลได้ใน LINE OA ของร้าน"
    ].join("\n");
  }

  return payload.text || "แจ้งเตือนจากระบบสมาชิกปิยสิริเคมีเกษตร";
}

async function pushLineMessage(to, text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    return {
      ok: false,
      status: 500,
      body: { error: "missing LINE_CHANNEL_ACCESS_TOKEN" }
    };
  }

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

  const responseText = await response.text();
  let responseBody = {};
  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseBody = { raw: responseText };
  }

  return {
    ok: response.ok,
    status: response.status,
    body: responseBody
  };
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "method not allowed" });

  let body = null;
  try {
    body = JSON.parse(event.body || "null");
  } catch {
    return json(400, { error: "invalid JSON body" });
  }

  if (!body?.to) return json(400, { error: "missing recipient user ID" });

  const text = buildText(body.type, body.payload || {});
  const result = await pushLineMessage(body.to, text);

  if (!result.ok) {
    console.error("LINE push failed", {
      status: result.status,
      detail: result.body
    });
    return json(result.status || 500, {
      error: "line push failed",
      detail: result.body
    });
  }

  return json(200, { ok: true });
}
