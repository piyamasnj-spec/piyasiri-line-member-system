export const PUBLIC_PROMOTIONS_CONFIG = Object.freeze({
  endpoint: "https://script.google.com/macros/s/AKfycbyLVPJPQy5XHmnE7tBv1roHtutqi4JuHg-quhSIQgkgU3wgLiVMVo5mijfyE3lebbfe/exec?route=public-promotions",
  localEndpointQuery: "promotionsEndpoint"
});

const ACTIVE_STATUS = "ใช้งาน";
const BANGKOK_TIME_ZONE = "Asia/Bangkok";

function text(value) {
  return String(value ?? "").trim();
}

function optionalNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateKeyInBangkok(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validIsoDate(value) {
  const result = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : "";
}

export function normalizePublicPromotion(value = {}) {
  return {
    code: text(value.code),
    name: text(value.name),
    type: text(value.type),
    purchaseProductCode: text(value.purchaseProductCode),
    purchaseProductName: text(value.purchaseProductName),
    minimumQuantity: optionalNumber(value.minimumQuantity),
    giftProductCode: text(value.giftProductCode),
    giftProductName: text(value.giftProductName),
    giftQuantity: optionalNumber(value.giftQuantity),
    specialPrice: optionalNumber(value.specialPrice),
    specialPriceMode: text(value.specialPriceMode),
    pointsMultiplier: optionalNumber(value.pointsMultiplier),
    repeatByQuantity: value.repeatByQuantity === true || text(value.repeatByQuantity) === "ใช่",
    startDate: validIsoDate(value.startDate),
    endDate: validIsoDate(value.endDate),
    status: text(value.status)
  };
}

export function isPublicPromotionVisible(value, now = new Date()) {
  const promotion = normalizePublicPromotion(value);
  if (!promotion.code || !promotion.name || promotion.status !== ACTIVE_STATUS) return false;
  if (!promotion.startDate || !promotion.endDate) return false;
  const today = dateKeyInBangkok(now);
  return promotion.startDate <= today && today <= promotion.endDate;
}

export function filterPublicPromotions(values, now = new Date()) {
  if (!Array.isArray(values)) return [];
  return values
    .filter(value => isPublicPromotionVisible(value, now))
    .map(value => normalizePublicPromotion(value));
}

export function promotionDescription(value) {
  const promotion = normalizePublicPromotion(value);
  const purchaseProduct = promotion.purchaseProductName || promotion.purchaseProductCode || "สินค้าที่ร่วมรายการ";
  const minimum = promotion.minimumQuantity ?? 1;

  if (promotion.type.includes("แถม")) {
    const giftProduct = promotion.giftProductName || promotion.giftProductCode || "สินค้าแถม";
    const giftQuantity = promotion.giftQuantity ?? 1;
    return `ซื้อ ${purchaseProduct} ครบ ${minimum} ชิ้น รับ ${giftProduct} ${giftQuantity} ชิ้น`;
  }
  if (promotion.type.includes("ราคา")) {
    const price = promotion.specialPrice === null ? "ตามที่ร้านกำหนด" : `${promotion.specialPrice.toLocaleString("th-TH")} บาท`;
    const mode = promotion.specialPriceMode ? ` (${promotion.specialPriceMode})` : "";
    return `ซื้อ ${purchaseProduct} ครบ ${minimum} ชิ้น รับราคาพิเศษ ${price}${mode}`;
  }
  if (promotion.type.includes("คะแนน")) {
    const multiplier = promotion.pointsMultiplier ?? 1;
    return `ซื้อ ${purchaseProduct} รับคะแนนสะสม ${multiplier} เท่า`;
  }
  return `ซื้อ ${purchaseProduct} ครบ ${minimum} ชิ้น ตามเงื่อนไขโปรโมชั่น`;
}

export function formatPromotionPeriod(value) {
  const promotion = normalizePublicPromotion(value);
  if (!promotion.startDate || !promotion.endDate) return "ไม่ระบุช่วงเวลา";
  const format = iso => new Intl.DateTimeFormat("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: BANGKOK_TIME_ZONE
  }).format(new Date(`${iso}T00:00:00+07:00`));
  return `${format(promotion.startDate)} – ${format(promotion.endDate)}`;
}

export function resolvePublicPromotionsEndpoint(locationLike) {
  const configured = text(PUBLIC_PROMOTIONS_CONFIG.endpoint);
  const hostname = text(locationLike?.hostname).toLowerCase();
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";

  if (isLocal) {
    const localValue = new URLSearchParams(locationLike?.search || "").get(PUBLIC_PROMOTIONS_CONFIG.localEndpointQuery);
    if (localValue) {
      try {
        const localUrl = new URL(localValue);
        if (["https:", "http:"].includes(localUrl.protocol)) return localUrl.href;
      } catch {
        return configured;
      }
    }
  }
  return configured;
}
