export function normalizeText(value) {
  return String(value ?? "").trim();
}

export function normalizePhone(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export function calculateBillPoints(items = [], rates = []) {
  const rateByCategory = new Map(
    rates.map((rate) => [normalizeText(rate.category), {
      threshold: Number(rate.threshold),
      points: Number(rate.points),
      active: rate.active === true || normalizeText(rate.active).toLowerCase() === "ใช่"
    }])
  );
  const amountByCategory = new Map();
  const alerts = [];

  for (const item of items) {
    const category = normalizeText(item.category);
    const amount = Number(item.amount || 0);
    if (!category) {
      alerts.push({
        type: "missing_product_category",
        productCode: normalizeText(item.productCode),
        message: "สินค้าไม่มีหมวด จึงไม่เพิ่มคะแนนให้รายการนี้"
      });
      continue;
    }
    if (!Number.isFinite(amount) || amount <= 0) continue;
    amountByCategory.set(category, (amountByCategory.get(category) || 0) + amount);
  }

  const breakdown = [];
  for (const [category, amount] of amountByCategory.entries()) {
    const rate = rateByCategory.get(category);
    let points = 0;
    let status = "calculated";
    let threshold = null;
    let pointsPerRate = null;

    if (!rate) {
      status = "missing_rate";
      alerts.push({ type: status, category, message: `ไม่พบเรทของหมวด ${category}` });
    } else if (!rate.active) {
      status = "disabled";
    } else if (!Number.isFinite(rate.threshold) || rate.threshold <= 0 || !Number.isFinite(rate.points) || rate.points <= 0) {
      status = "invalid_rate";
      alerts.push({ type: status, category, message: `เรทของหมวด ${category} เป็นค่าว่าง 0 หรือติดลบ` });
    } else {
      threshold = rate.threshold;
      pointsPerRate = rate.points;
      points = Math.floor(amount / threshold) * pointsPerRate;
    }

    breakdown.push({ category, amount, threshold, pointsPerRate, points, status });
  }

  return {
    amount: breakdown.reduce((sum, item) => sum + item.amount, 0),
    points: breakdown.reduce((sum, item) => sum + item.points, 0),
    breakdown,
    alerts
  };
}

export function recommendedRewardPoints(cost, pointValue = 1, safetyPercent = 0.25) {
  const actualCost = Number(cost);
  const valuePerPoint = Number(pointValue);
  const safety = Number(safetyPercent);
  if (!Number.isFinite(actualCost) || actualCost < 0 || !Number.isFinite(valuePerPoint) || valuePerPoint <= 0 || !Number.isFinite(safety) || safety < 0) {
    return null;
  }
  return Math.ceil((actualCost / valuePerPoint) * (1 + safety));
}

export function validateStoredPointResult(result) {
  if (!result || !Array.isArray(result.breakdown)) throw new Error("missing point breakdown");
  const points = result.breakdown.reduce((sum, item) => {
    const value = Number(item.points || 0);
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid category points");
    return sum + value;
  }, 0);
  if (points !== Number(result.points || 0)) throw new Error("point total does not match breakdown");
  return { ...result, points };
}
