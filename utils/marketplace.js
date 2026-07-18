function safeCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function normalizeIntent(value) {
  const intent = String(value || "").trim().toLowerCase();
  return ["high", "medium", "low"].includes(intent) ? intent : "not_assessed";
}

module.exports = { normalizeIntent, safeCount };
