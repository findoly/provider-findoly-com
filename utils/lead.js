const { leadCostCredits } = require("./credits");
const { normalizeIntent, safeCount } = require("./marketplace");

const SENSITIVE_KEY =
  /(name|mobile|phone|email|address|contact|whatsapp|customer|latitude|longitude|locationlink)/i;

function sanitizeDetails(value, depth = 0) {
  if (depth > 6) return null;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDetails(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;

  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    clean[key] = sanitizeDetails(child, depth + 1);
  }
  return clean;
}

function presentLead(row = {}) {
  const unlocked = row.contactUnlocked === true || row.status === "unlocked";
  const unlockedCount = safeCount(row.marketplaceUnlockedCount ?? row.unlockedCount);
  const confirmedCount = safeCount(
    row.marketplaceConfirmedCount ?? row.providerConfirmedCount,
  );
  const baseCredits = Math.max(0, Number(
    row.baseLeadCostCredits ?? row.marketplaceBaseCredits ?? leadCostCredits(row),
  ));


  const lead = {
    leadDistributionId: row.leadDistributionId || row.id || "",
    enquiryId: row.enquiryId || row.requirementId || "",
    categorySlug: row.categorySlug || "",
    status: row.status || "",
    leadPricePaise: Number(row.leadPricePaise || 0),
    leadCostCredits: baseCredits,
    baseLeadCostCredits: baseCredits,
    effectiveLeadCostCredits: baseCredits,
    unlockDiscountPercent: 0,
    unlockSavingsCredits: 0,
    unlockCountAtPrice: unlockedCount,
    currency: row.currency || "INR",
    contactUnlocked: unlocked,
    leadTitle: row.leadTitle || "",
    serviceType: row.serviceType || "",
    category: row.category || "",
    city: row.city || "",
    state: row.state || "",
    pincode: row.pincode || "",
    preferredDate: row.preferredDate || "",
    preferredSlot: row.preferredSlot || "",
    priority: row.priority || "normal",
    leadIntent: normalizeIntent(row.leadIntent || row.marketplaceLeadIntent),
    unlockedCount,
    providerConfirmedCount: confirmedCount,
    currentlyConfirmed: confirmedCount > 0,
    providerDistanceKm: Number.isFinite(Number(row.providerDistanceKm)) ? Number(row.providerDistanceKm) : null,
    marketplacePublishedAt: row.marketplacePublishedAt || null,
    marketplaceVisibleAt: row.marketplaceVisibleAt || null,
    additionalDetails: unlocked
      ? row.additionalDetails || {}
      : sanitizeDetails(row.additionalDetails || {}),
    distributedAt: row.distributedAt || row.createdAt || null,
    unlockedAt: row.unlockedAt || null,
    unlockMethod: unlocked
      ? row.unlockMethod || (row.walletTransactionId ? "credits" : "")
      : "",
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };

  if (unlocked) {
    lead.customerName = row.customerName || "";
    lead.customerMobile = row.customerMobile || "";
    lead.customerEmail = row.customerEmail || "";
    lead.customerAddress = row.customerAddress || "";
    lead.providerSaleOutcome = row.providerSaleOutcome ||
      (row.providerLeadStatus === "confirmed" ? "confirmed" : "");
    lead.providerSaleOutcomeNote = row.providerSaleOutcomeNote || "";
    lead.providerSaleOutcomeUpdatedAt = row.providerSaleOutcomeUpdatedAt || null;
    lead.providerLeadStatus = row.providerLeadStatus === "confirmed"
      ? ""
      : row.providerLeadStatus || "";
    lead.providerLeadReason = row.providerLeadReason || "";
    lead.providerLeadNote = row.providerLeadNote || "";
    lead.providerLeadStatusUpdatedAt = row.providerLeadStatusUpdatedAt || null;
    lead.outcomeVerificationStatus = row.outcomeVerificationStatus || "";
    lead.outcomeVerificationNote = row.outcomeVerificationNote || "";
    lead.crmSyncStatus = row.crmSyncStatus || "";
    lead.crmSyncError = row.crmSyncError || "";
  }

  return lead;
}

module.exports = { presentLead, sanitizeDetails };
