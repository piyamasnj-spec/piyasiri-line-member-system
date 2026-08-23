export const CUSTOMER_ROUTES = Object.freeze({
  "#member": "screenHome",
  "#register": "screenRegister",
  "#points": "screenPoints",
  "#redeem": "screenRedeem",
  "#rewards": "screenRewards",
  "#history": "screenHistory",
  "#redemption-history": "screenRedemptionHistory",
  "#promotions": "screenPromotions",
  "#profile": "screenProfile"
});

export const SCREEN_HASHES = Object.freeze(Object.fromEntries(
  Object.entries(CUSTOMER_ROUTES).map(([hash, screenId]) => [screenId, hash])
));

export function resolveCustomerRoute(hash = "#member") {
  const normalizedHash = hash || "#member";
  const screenId = CUSTOMER_ROUTES[normalizedHash];
  return screenId
    ? { valid: true, hash: normalizedHash, screenId }
    : { valid: false, hash: normalizedHash, screenId: "screenRouteError" };
}

export function hashForScreen(screenId) {
  return SCREEN_HASHES[screenId] || null;
}

export function bottomNavTarget(screenId) {
  if (["screenRewards", "screenRedeem"].includes(screenId)) return "screenRewards";
  if (["screenHistory", "screenRedemptionHistory"].includes(screenId)) return "screenHistory";
  if (screenId === "screenProfile") return "screenProfile";
  return "screenHome";
}
