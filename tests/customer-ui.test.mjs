import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const memberStart = html.indexOf('<section class="view" id="memberView">');
const adminStart = html.indexOf('<section class="view" id="adminView">');
const memberMarkup = html.slice(memberStart, adminStart);

test("customer UI has no purchase submission entry or form", () => {
  assert.equal(memberMarkup.includes("screenSubmit"), false);
  assert.equal(memberMarkup.includes("submitPurchaseForm"), false);
  assert.equal(memberMarkup.includes("purchaseProof"), false);
  assert.equal(memberMarkup.includes("แจ้งยอดซื้อ"), false);
});

test("customer home exposes the required read-only destinations", () => {
  assert.match(html, /คะแนนของฉัน/);
  assert.match(memberMarkup, />ของรางวัล</);
  assert.match(memberMarkup, />ประวัติ</);
  assert.match(memberMarkup, />โปรไฟล์</);
  assert.match(html, /ประวัติแลกของรางวัล/);
  assert.match(html, /คะแนนจะถูกบันทึกโดยร้านหลังการซื้อสินค้า/);
});

test("all four main menu buttons have the required click destinations", () => {
  const expected = [
    ["screenHistory", "คะแนนของฉัน"],
    ["screenRewards", "ของรางวัล"],
    ["screenPromotions", "โปรโมชั่น"],
    ["screenRedemptionHistory", "ประวัติแลกของรางวัล"]
  ];
  for (const [screen, label] of expected) {
    const button = new RegExp(`<button class="menu-tile" data-screen="${screen}">[\\s\\S]*?<strong>${label}<\\/strong>`);
    assert.match(html, button);
  }
  assert.equal((html.match(/<button class="menu-tile"/g) || []).length, 4);
});

test("promotion and local mock remain centrally configured and localhost-only", () => {
  assert.match(html, /const PROMOTION_CONFIG = Object\.freeze/);
  assert.match(html, /function isLocalPreview/);
  assert.match(html, /\["localhost", "127\.0\.0\.1"\]/);
  assert.match(memberMarkup, /id="screenPromotions"/);
  assert.match(memberMarkup, /id="screenProfile"/);
  assert.match(html, /title: "",\s*description: ""/);
  assert.match(html, /ยังไม่มีโปรโมชั่นในขณะนี้/);
  assert.match(html, /let currentLineUserId = null/);
  assert.match(html, /if \(isLocalPreview\(\)\) \{\s*currentLineUserId = MOCK_LINE_USER_ID/);
  assert.doesNotMatch(html, /LIFF init failed; using demo mode/);
});

test("optional member fields are hidden when backend fields are absent", () => {
  assert.match(html, /nextExpiry\?\.expiresAt/);
  assert.match(html, /customer\.area \? `<div class="profile-field"/);
  assert.match(html, /customer\.joinedAt \? `<div class="profile-field"/);
  assert.doesNotMatch(html, /customer\.area \|\| "ยังไม่ระบุ"/);
});

test("guest reward page shows signup invitation instead of actionable rewards", () => {
  assert.match(html, /if \(!customer\) \{[\s\S]*?สมัครสมาชิกเพื่อดูและแลกของรางวัล[\s\S]*?return;/);
});

test("brand and replaceable image system are centrally configured", () => {
  assert.match(html, /storeLogo: "assets\/images\/piyasiri-logo\.png"/);
  assert.match(html, /rewardImageDirectory: "assets\/rewards\/"/);
  assert.match(html, /function imageMarkup/);
  assert.equal(/data:image\//.test(html), false);
});
