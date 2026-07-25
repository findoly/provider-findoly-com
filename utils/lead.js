const { leadCostCredits } = require("./credits");

const SENSITIVE_KEY = /(name|mobile|phone|email|address|contact|whatsapp|customer|latitude|longitude|locationlink)/i;

function sanitizeDetails(value, depth = 0) {
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.map((item) => sanitizeDetails(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (!SENSITIVE_KEY.test(key)) clean[key] = sanitizeDetails(child, depth + 1);
  }
  return clean;
}

function safeCount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function serviceTypes(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      serviceTypeId: item?.serviceTypeId || item?.id || "",
      name: item?.name || String(item || ""),
      slug: item?.slug || "",
    }))
    .filter((item) => item.name)
    .slice(0, 5);
}

function presentLead(enquiry = {}, unlock = null, visibility = {}) {
  const unlocked = Boolean(unlock?.providerLeadUnlockId);
  const unlockedCount = safeCount(enquiry.unlockedCount);
  const reservedUnlockCount = safeCount(enquiry.reservedUnlockCount);
  const maxProviderUnlocks = Math.max(1, safeCount(enquiry.maxProviderUnlocks) || 5);
  const remainingUnlocks = safeCount(enquiry.remainingUnlocks);
  const baseCredits = Math.max(0, Number(enquiry.leadCostCredits ?? leadCostCredits(enquiry)));
  const result = {
    enquiryId: enquiry.enquiryId || "",
    providerLeadUnlockId: unlock?.providerLeadUnlockId || "",
    recordId: unlock?.providerLeadUnlockId || enquiry.enquiryId || "",
    categorySlug: enquiry.categorySlug || unlock?.categorySlug || "",
    category: enquiry.category || unlock?.category || "",
    leadTitle: enquiry.requirementTitle || unlock?.leadTitle || "",
    serviceType: enquiry.serviceType || serviceTypes(enquiry.serviceTypes)[0]?.name || "",
    serviceTypes: serviceTypes(enquiry.serviceTypes || unlock?.serviceTypes),
    priority: enquiry.priority || unlock?.priority || "normal",
    city: enquiry.city || unlock?.city || "",
    state: enquiry.state || unlock?.state || "",
    pincode: enquiry.pincode || unlock?.pincode || "",
    preferredDate: enquiry.preferredDate || "",
    preferredSlot: enquiry.preferredSlot || "",
    leadPricePaise: Number(enquiry.leadPricePaise ?? unlock?.leadPricePaise ?? 0),
    leadCostCredits: baseCredits,
    baseLeadCostCredits: baseCredits,
    effectiveLeadCostCredits: baseCredits,
    currency: enquiry.currency || unlock?.currency || "INR",
    marketplaceStatus: enquiry.marketplaceStatus || "",
    marketplaceAvailable: enquiry.marketplaceAvailable === true,
    marketplacePublishedAt: enquiry.marketplacePublishedAt || null,
    marketplaceExpiresAt: enquiry.marketplaceExpiresAt || null,
    marketplaceVisibleAt: visibility.marketplaceVisibleAt || null,
    providerDistanceKm: nullableNumber(visibility.providerDistanceKm),
    maxProviderUnlocks,
    unlockedCount,
    reservedUnlockCount,
    remainingUnlocks,
    unlockCapacityReached: remainingUnlocks <= 0,
    providerConfirmedCount: safeCount(enquiry.providerConfirmedCount),
    contactUnlocked: unlocked,
    status: unlocked ? "unlocked" : "available",
    additionalDetails: unlocked
      ? enquiry.additionalDetails || {}
      : sanitizeDetails(enquiry.additionalDetails || {}),
    unlockedAt: unlock?.unlockedAt || null,
    unlockMethod: unlock?.unlockMethod || "",
    chargedCredits: Number(unlock?.chargedCredits || 0),
    chargedPaise: Number(unlock?.chargedPaise || 0),
    createdAt: enquiry.createdAt || unlock?.createdAt || null,
    updatedAt: unlock?.updatedAt || enquiry.updatedAt || null,
    daysPending: unlocked && unlock?.unlockedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(unlock.unlockedAt).getTime()) / 86400000))
      : 0,
  };

  if (unlocked) {
    Object.assign(result, {
      customerName: enquiry.name || "",
      customerMobile: enquiry.mobile || "",
      customerEmail: enquiry.email || "",
      customerAddress: enquiry.addressLine || "",
      providerSaleOutcome: unlock.providerSaleOutcome || "",
      providerSaleOutcomeNote: unlock.providerSaleOutcomeNote || "",
      providerSaleOutcomeUpdatedAt: unlock.providerSaleOutcomeUpdatedAt || null,
      providerLeadStatus: unlock.providerLeadStatus || "",
      providerLeadReason: unlock.providerLeadReason || "",
      providerLeadNote: unlock.providerLeadNote || "",
      providerLeadStatusUpdatedAt: unlock.providerLeadStatusUpdatedAt || null,
      outcomeVerificationStatus: unlock.outcomeVerificationStatus || "",
      outcomeVerificationNote: unlock.outcomeVerificationNote || "",
      crmSyncStatus: unlock.crmSyncStatus || "",
      crmSyncError: unlock.crmSyncError || "",
    });
  }
  return result;
}

module.exports = { presentLead, sanitizeDetails, safeCount };
