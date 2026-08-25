import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { bottomNavTarget, hashForScreen, resolveCustomerRoute } from "../src/customer-routes.mjs";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

const expectedRoutes = [
  ["#member", "screenHome"],
  ["#rewards", "screenRewards"],
  ["#history", "screenHistory"],
  ["#profile", "screenProfile"]
];

test("member deep links resolve to four different customer pages", () => {
  const screens = expectedRoutes.map(([hash, screenId]) => {
    const resolved = resolveCustomerRoute(hash);
    assert.deepEqual(resolved, { valid: true, hash, screenId });
    return resolved.screenId;
  });
  assert.equal(new Set(screens).size, 4);
});

test("preview query before hash does not change the member route", () => {
  for (const [hash, screenId] of expectedRoutes) {
    const url = new URL(`http://127.0.0.1:4173/?preview=member${hash}`);
    assert.equal(url.searchParams.get("preview"), "member");
    assert.equal(resolveCustomerRoute(url.hash).screenId, screenId);
  }
});

test("each routed screen has its own title and container", () => {
  assert.match(html, /id="screenHome"/);
  assert.match(html, /id="screenRewards"[\s\S]*?<h2>ของรางวัล<\/h2>[\s\S]*?id="rewardCatalog"/);
  assert.match(html, /id="screenHistory"[\s\S]*?<h2>ประวัติคะแนน<\/h2>[\s\S]*?id="customerHistory"/);
  assert.match(html, /id="screenProfile"[\s\S]*?<h2>โปรไฟล์<\/h2>[\s\S]*?id="profileContent"/);
});

test("bottom navigation and screen hashes map consistently", () => {
  assert.equal(hashForScreen("screenHome"), "#member");
  assert.equal(hashForScreen("screenRewards"), "#rewards");
  assert.equal(hashForScreen("screenHistory"), "#history");
  assert.equal(hashForScreen("screenProfile"), "#profile");
  assert.equal(bottomNavTarget("screenHome"), "screenHome");
  assert.equal(bottomNavTarget("screenRewards"), "screenRewards");
  assert.equal(bottomNavTarget("screenHistory"), "screenHistory");
  assert.equal(bottomNavTarget("screenProfile"), "screenProfile");
});

test("unknown customer hash shows an explicit route error", () => {
  assert.deepEqual(resolveCustomerRoute("#unknown"), { valid: false, hash: "#unknown", screenId: "screenRouteError" });
  assert.match(html, /id="screenRouteError"[\s\S]*?ไม่พบหน้านี้/);
});
