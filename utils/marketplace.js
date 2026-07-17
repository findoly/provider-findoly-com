const DISCOUNT_TIERS = Object.freeze([
  { minUnlocks: 8, discountPercent: 75 },
  { minUnlocks: 5, discountPercent: 50 },
  { minUnlocks: 3, discountPercent: 40 },
  { minUnlocks: 1, discountPercent: 20 },
  { minUnlocks: 0, discountPercent: 0 },
]);

function safeCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function discountPercentForUnlocks(previousUnlocks) {
  const unlocks = safeCount(previousUnlocks);
  return DISCOUNT_TIERS.find((tier) => unlocks >= tier.minUnlocks)?.discountPercent || 0;
}

function discountedCredits(baseCredits, previousUnlocks) {
  const base = Math.max(0, Number(baseCredits || 0));
  const discountPercent = discountPercentForUnlocks(previousUnlocks);
  const effective = Math.max(0, Math.round(base * (100 - discountPercent)) / 100);
  return {
    baseCredits: base,
    effectiveCredits: effective,
    discountPercent,
    savingsCredits: Math.max(0, Math.round((base - effective) * 100) / 100),
    previousUnlocks: safeCount(previousUnlocks),
  };
}

function competitionLevel(unlockedCount) {
  const count = safeCount(unlockedCount);
  if (count >= 4) return "high";
  if (count >= 2) return "medium";
  return "low";
}

function normalizeIntent(value) {
  const intent = String(value || "").trim().toLowerCase();
  return ["high", "medium", "low"].includes(intent) ? intent : "not_assessed";
}

module.exports = {
  DISCOUNT_TIERS,
  competitionLevel,
  discountedCredits,
  discountPercentForUnlocks,
  normalizeIntent,
  safeCount,
};
