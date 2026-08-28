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

function normalizeAddressPart(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function addressKey(value) {
  return normalizeAddressPart(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function pushAddressPart(parts, value) {
  const candidates = String(value || "").split(",").map(normalizeAddressPart).filter(Boolean);
  for (const candidate of candidates) {
    const key = addressKey(candidate);
    if (!key) continue;
    const duplicate = parts.some((part) => {
      const existing = addressKey(part);
      return existing === key || existing.includes(key) || key.includes(existing);
    });
    if (!duplicate) parts.push(candidate);
  }
}

function joinAddress(values = []) {
  const parts = [];
  for (const value of values) pushAddressPart(parts, value);
  return parts.join(", ");
}

function serviceAreaAddress(enquiry = {}, unlock = null) {
  return joinAddress([
    enquiry.city || unlock?.city || enquiry.locationDistrict || enquiry.locationLocality,
    enquiry.state || unlock?.state || enquiry.locationState,
    enquiry.pincode || unlock?.pincode || enquiry.locationPincode,
  ]) || normalizeAddressPart(
    enquiry.locationLocality
      || enquiry.locationDistrict
      || enquiry.locationState
      || enquiry.locationPincode,
  );
}

function fullCustomerAddress(enquiry = {}) {
  return joinAddress([
    enquiry.addressLine,
    enquiry.locationLocality,
    enquiry.city,
    enquiry.locationDistrict,
    enquiry.state || enquiry.locationState,
    enquiry.pincode || enquiry.locationPincode,
    enquiry.locationCountry || "India",
  ]);
}

function validCoordinate(value, min, max) {
  if (value === null || value === undefined || String(value).trim() === "") return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max;
}

function trustedCustomerCoordinates(enquiry = {}) {
  if (String(enquiry.locationSource || "").trim().toLowerCase() === "manual_pincode") return null;
  const pincode = String(enquiry.pincode || "").trim();
  const locationPincode = String(enquiry.locationPincode || "").trim();
  if (pincode && locationPincode && pincode !== locationPincode) return null;
  if (!validCoordinate(enquiry.locationLatitude, -90, 90)
    || !validCoordinate(enquiry.locationLongitude, -180, 180)) {
    return null;
  }
  return {
    latitude: Number(enquiry.locationLatitude),
    longitude: Number(enquiry.locationLongitude),
  };
}

function googleMapsSearchUrl(query) {
  const value = normalizeAddressPart(query);
  return value
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}`
    : "";
}

function presentLead(enquiry = {}, unlock = null, visibility = {}) {
  const unlocked = Boolean(unlock?.providerLeadUnlockId);
  const unlockedCount = safeCount(enquiry.unlockedCount);
  const reservedUnlockCount = safeCount(enquiry.reservedUnlockCount);
  const maxProviderUnlocks = Math.max(1, safeCount(enquiry.maxProviderUnlocks) || 5);
  const remainingUnlocks = safeCount(enquiry.remainingUnlocks);
  const baseCredits = Math.max(0, Number(enquiry.leadCostCredits ?? leadCostCredits(enquiry)));
  const approximateAddress = serviceAreaAddress(enquiry, unlock);
  const result = {
    enquiryId: enquiry.enquiryId || "",
    providerLeadUnlockId: unlock?.providerLeadUnlockId || "",
    recordId: unlock?.providerLeadUnlockId || enquiry.enquiryId || "",
    categorySlug: enquiry.categorySlug || unlock?.categorySlug || "",
    category: enquiry.category || unlock?.category || "",
    leadTitle: enquiry.providerRequirementTitle || enquiry.requirementTitle || unlock?.leadTitle || "",
    providerRequirementTitle: enquiry.providerRequirementTitle || "",
    providerRequirementDetails: enquiry.providerRequirementDetails || "",
    serviceType: enquiry.serviceType || serviceTypes(enquiry.serviceTypes)[0]?.name || "",
    serviceTypes: serviceTypes(enquiry.serviceTypes || unlock?.serviceTypes),
    priority: enquiry.priority || unlock?.priority || "normal",
    city: enquiry.city || unlock?.city || "",
    state: enquiry.state || unlock?.state || "",
    pincode: enquiry.pincode || unlock?.pincode || "",
    serviceAreaAddress: approximateAddress,
    serviceAreaMapUrl: googleMapsSearchUrl(approximateAddress),
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
    const customerAddress = fullCustomerAddress(enquiry) || approximateAddress;
    const coordinates = trustedCustomerCoordinates(enquiry);
    const customerMapQuery = coordinates
      ? `${coordinates.latitude},${coordinates.longitude}`
      : customerAddress;
    Object.assign(result, {
      customerName: enquiry.name || "",
      customerMobile: enquiry.mobile || "",
      customerEmail: enquiry.email || "",
      customerAddress,
      customerMapUrl: googleMapsSearchUrl(customerMapQuery),
      customerLocationLatitude: coordinates?.latitude ?? null,
      customerLocationLongitude: coordinates?.longitude ?? null,
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

module.exports = {
  presentLead,
  sanitizeDetails,
  safeCount,
  serviceAreaAddress,
  fullCustomerAddress,
  trustedCustomerCoordinates,
  googleMapsSearchUrl,
};
