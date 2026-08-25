import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  PUBLIC_PROMOTIONS_CONFIG,
  filterPublicPromotions,
  isPublicPromotionVisible,
  promotionDescription,
  resolvePublicPromotionsEndpoint
} from "../src/public-promotions.mjs";

const now = new Date("2026-08-25T12:00:00+07:00");
const activePromotion = {
  code: "PROMO-GIFT-A",
  name: "ซื้อครบรับสินค้าแถม",
  type: "ซื้อครบจำนวนแถมสินค้า",
  purchaseProductCode: "PRODUCT-A",
  minimumQuantity: 12,
  giftProductCode: "PRODUCT-GIFT",
  giftQuantity: 1,
  startDate: "2026-08-20",
  endDate: "2026-08-31",
  status: "ใช้งาน"
};

test("customer filter keeps only active promotions inside the inclusive date range", () => {
  const values = [
    activePromotion,
    { ...activePromotion, code: "PROMO-FUTURE", startDate: "2026-08-26" },
    { ...activePromotion, code: "PROMO-EXPIRED", endDate: "2026-08-24" },
    { ...activePromotion, code: "PROMO-OFF", status: "ปิด" }
  ];
  assert.deepEqual(filterPublicPromotions(values, now).map(item => item.code), ["PROMO-GIFT-A"]);
  assert.equal(isPublicPromotionVisible({ ...activePromotion, startDate: "2026-08-25", endDate: "2026-08-25" }, now), true);
  assert.equal(isPublicPromotionVisible({ ...activePromotion, startDate: "", endDate: "" }, now), false);
});

test("promotion copy is derived from public fields without inventing product names", () => {
  assert.equal(
    promotionDescription(activePromotion),
    "ซื้อ PRODUCT-A ครบ 12 ชิ้น รับ PRODUCT-GIFT 1 ชิ้น"
  );
});

test("local endpoint override is ignored outside localhost", () => {
  const query = "?promotionsEndpoint=https%3A%2F%2Fscript.google.com%2Fmacros%2Fs%2Fpreview%2Fexec";
  assert.equal(resolvePublicPromotionsEndpoint({ hostname: "localhost", search: query }), "https://script.google.com/macros/s/preview/exec");
  assert.equal(resolvePublicPromotionsEndpoint({ hostname: "piyasiri-line-member-system.netlify.app", search: query }), PUBLIC_PROMOTIONS_CONFIG.endpoint);
  assert.doesNotMatch(PUBLIC_PROMOTIONS_CONFIG.endpoint, /localhost|127\.0\.0\.1|preview=/i);
});

const appsScriptSource = await readFile(new URL("../apps-script/PublicPromotions.gs", import.meta.url), "utf8");

function formatDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function appsScriptContext(rows) {
  const rangeCalls = [];
  const output = text => ({
    text,
    mimeType: "",
    setMimeType(value) {
      this.mimeType = value;
      return this;
    }
  });
  const sheet = {
    getLastRow: () => rows.length + 1,
    getRange(...args) {
      rangeCalls.push(args);
      return { getValues: () => rows };
    }
  };
  const context = vm.createContext({
    console: { error() {} },
    Date,
    isFinite,
    isNaN,
    JSON,
    Number,
    Object,
    String,
    SpreadsheetApp: {
      openById: id => {
        assert.equal(id, "1YQBSm6XcdGgqB3hflV_4vAG27oqRC0eSQ6Fv3rwL3KI");
        return {
          getSheetByName: name => {
            assert.equal(name, "โปรโมชั่น");
            return sheet;
          },
          getSpreadsheetTimeZone: () => "Asia/Bangkok"
        };
      }
    },
    Session: { getScriptTimeZone: () => "Asia/Bangkok" },
    Utilities: { formatDate: (date, timeZone) => formatDate(date, timeZone) },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: output
    }
  });
  vm.runInContext(appsScriptSource, context);
  return { context, rangeCalls };
}

test("Apps Script reads only A:N and filters inactive, future, and expired rows", () => {
  const row = ({ code, start, end, status = "ใช้งาน" }) => [
    code, `ชื่อ ${code}`, "PRODUCT-A", 12, "ซื้อครบจำนวนแถมสินค้า", "PRODUCT-GIFT", 1,
    "", "", 1, "ใช่", start, end, status
  ];
  const rows = [
    row({ code: "PROMO-ACTIVE", start: new Date("2026-08-20T00:00:00+07:00"), end: new Date("2026-08-31T00:00:00+07:00") }),
    row({ code: "PROMO-FUTURE", start: new Date("2026-08-26T00:00:00+07:00"), end: new Date("2026-08-31T00:00:00+07:00") }),
    row({ code: "PROMO-EXPIRED", start: new Date("2026-08-01T00:00:00+07:00"), end: new Date("2026-08-24T00:00:00+07:00") }),
    row({ code: "PROMO-OFF", start: new Date("2026-08-20T00:00:00+07:00"), end: new Date("2026-08-31T00:00:00+07:00"), status: "ปิด" })
  ];
  const { context, rangeCalls } = appsScriptContext(rows);
  const result = context.listPublicPromotions_(now);
  assert.deepEqual(Array.from(result, item => item.code), ["PROMO-ACTIVE"]);
  assert.deepEqual(rangeCalls, [[2, 1, 4, 14]]);
  assert.deepEqual(Object.keys(result[0]).sort(), [
    "code", "endDate", "giftProductCode", "giftQuantity", "minimumQuantity", "name",
    "pointsMultiplier", "purchaseProductCode", "repeatByQuantity", "specialPrice",
    "specialPriceMode", "startDate", "status", "type"
  ]);
});

test("Apps Script returns an empty public list when the sheet has no data", () => {
  const { context, rangeCalls } = appsScriptContext([]);
  assert.deepEqual(Array.from(context.listPublicPromotions_(now)), []);
  assert.deepEqual(rangeCalls, []);
});

test("Apps Script accepts the date serial format returned by the confirmed preview copy", () => {
  const rows = [[
    "PROMO-SERIAL", "โปรโมชั่นตามช่วงวันที่", "PRODUCT-A", 1, "คะแนนพิเศษ", "", 0,
    0, "", 2, "ไม่ใช่", "46248", "46260", "ใช้งาน"
  ]];
  const { context } = appsScriptContext(rows);
  assert.deepEqual(Array.from(context.listPublicPromotions_(now), item => item.code), ["PROMO-SERIAL"]);
});

test("Apps Script route is GET-only and source contains no spreadsheet write operation", () => {
  const { context } = appsScriptContext([]);
  assert.equal((appsScriptSource.match(/function\s+doGet\s*\(/g) || []).length, 1);
  const notFound = context.doGet({ parameter: { route: "not-this-route" } });
  assert.deepEqual(JSON.parse(notFound.text), { ok: false, error: "NOT_FOUND" });
  const response = context.routePublicPromotionsGet_({ parameter: { route: "public-promotions" } });
  assert.equal(response.mimeType, "application/json");
  assert.deepEqual(JSON.parse(response.text), { ok: true, promotions: [] });
  assert.doesNotMatch(appsScriptSource, /function\s+doPost\b/);
  assert.doesNotMatch(appsScriptSource, /\.(?:setValue|setValues|appendRow|deleteRow|insertRow|clear|clearContent|deleteSheet)\s*\(/);
});
