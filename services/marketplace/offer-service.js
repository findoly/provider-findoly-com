const Enquiry = require("../../models/Enquiry");
const LeadDistribution = require("../../models/LeadDistribution");
const uuid = require("../../utils/uuid");
const { leadCostCredits } = require("../../utils/credits");
const {
  providerCategories,
  providerIdentity,
} = require("../../utils/provider");
const {
  haversineDistanceKm,
  isMarketplaceVisible,
  isMarketplaceWithinAge,
  marketplaceVisibleAt,
} = require("../../utils/marketplace-radius");

const MARKETPLACE_PREFIX = "marketplace:";
const MARKETPLACE_STATUSES = Object.freeze([
  "distributed",
  "sale_converted",
  "in_progress",
  "completed",
  "closed",
]);
const DEFAULT_MAX_PROVIDER_UNLOCKS = 5;

function enquiryQuery(enquiryId) {
  return { $or: [{ enquiryId }, { id: enquiryId }] };
}

function marketplaceLeadId(enquiryId) {
  return `${MARKETPLACE_PREFIX}${String(enquiryId || "").trim()}`;
}

function marketplaceEnquiryId(identifier) {
  const value = String(identifier || "").trim();
  return value.startsWith(MARKETPLACE_PREFIX)
    ? value.slice(MARKETPLACE_PREFIX.length).trim()
    : "";
}

function maxProviderUnlocks(enquiry = {}) {
  const value = Number(enquiry.maxProviderUnlocks);
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_PROVIDER_UNLOCKS;
}

function unlockedCount(enquiry = {}) {
  const value = Number(enquiry.unlockedCount || 0);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function remainingUnlocks(enquiry = {}) {
  return Math.max(0, maxProviderUnlocks(enquiry) - unlockedCount(enquiry));
}

function availableUnlockSlots(enquiry = {}) {
  const pending = Number(enquiry.pendingUnlockCount || 0);
  const pendingCount = Number.isFinite(pending) ? Math.max(0, Math.floor(pending)) : 0;
  return Math.max(0, remainingUnlocks(enquiry) - pendingCount);
}

function hasCoordinateValue(value) {
  return value !== null
    && value !== undefined
    && String(value).trim() !== ""
    && Number.isFinite(Number(value));
}

function hasCoordinates(record = {}, prefix = "service") {
  return hasCoordinateValue(record[`${prefix}Latitude`])
    && hasCoordinateValue(record[`${prefix}Longitude`]);
}

function visibilityForEnquiry(enquiry = {}, provider = {}) {
  const publishedAt = enquiry.marketplacePublishedAt || enquiry.distributedAt || null;
  const distanceKm = hasCoordinates(enquiry, "location") && hasCoordinates(provider, "service")
    ? haversineDistanceKm(
      provider.serviceLatitude,
      provider.serviceLongitude,
      enquiry.locationLatitude,
      enquiry.locationLongitude,
    )
    : null;

  return {
    providerDistanceKm: distanceKm,
    marketplacePublishedAt: publishedAt,
    marketplaceVisibleAt: marketplaceVisibleAt(publishedAt, distanceKm),
  };
}

function isMarketplaceStatus(enquiry = {}) {
  return MARKETPLACE_STATUSES.includes(String(enquiry.status || enquiry.journeyStatus || "").toLowerCase());
}

function assertMarketplaceEligibility(provider = {}, enquiry = {}, now = new Date()) {
  const categories = providerCategories(provider);
  const publishedAt = enquiry.marketplacePublishedAt || enquiry.distributedAt || null;
  if (!isMarketplaceStatus(enquiry) || enquiry.isActive === false) {
    throw Object.assign(new Error("This lead is no longer available"), {
      status: 410,
      code: "LEAD_NOT_AVAILABLE",
    });
  }
  if (!publishedAt || !isMarketplaceWithinAge(publishedAt, now)) {
    throw Object.assign(new Error("This lead is outside the marketplace availability period"), {
      status: 410,
      code: "LEAD_MARKETPLACE_EXPIRED",
    });
  }
  if (!categories.includes(String(enquiry.categorySlug || ""))) {
    throw Object.assign(new Error("This lead does not match your provider categories"), {
      status: 404,
      code: "LEAD_NOT_FOUND",
    });
  }
  if (availableUnlockSlots(enquiry) <= 0) {
    throw Object.assign(new Error("This lead has reached its provider unlock limit"), {
      status: 409,
      code: "LEAD_UNLOCK_LIMIT_REACHED",
    });
  }
  const visibility = visibilityForEnquiry(enquiry, provider);
  if (!isMarketplaceVisible(visibility, now)) {
    throw Object.assign(new Error("This lead is not available in your service radius yet"), {
      status: 404,
      code: "LEAD_NOT_AVAILABLE_IN_RADIUS",
    });
  }
  return visibility;
}

function offerData(enquiry = {}, provider = {}, visibility = visibilityForEnquiry(enquiry, provider)) {
  const publishedAt = visibility.marketplacePublishedAt || enquiry.marketplacePublishedAt || enquiry.distributedAt || new Date();
  return {
    enquiryId: enquiry.enquiryId || enquiry.id,
    providerId: providerIdentity(provider),
    categorySlug: enquiry.categorySlug || "",
    leadPricePaise: Number(enquiry.leadPricePaise || 0),
    leadCostCredits: Number.isFinite(Number(enquiry.leadCostCredits))
      ? Number(enquiry.leadCostCredits)
      : leadCostCredits(enquiry),
    currency: enquiry.currency || "INR",
    leadTitle: enquiry.requirementTitle || enquiry.leadTitle || "",
    serviceType: enquiry.serviceType || "",
    category: enquiry.category || "",
    city: enquiry.city || "",
    state: enquiry.state || "",
    pincode: enquiry.pincode || "",
    leadLatitude: hasCoordinates(enquiry, "location") ? Number(enquiry.locationLatitude) : null,
    leadLongitude: hasCoordinates(enquiry, "location") ? Number(enquiry.locationLongitude) : null,
    providerDistanceKm: visibility.providerDistanceKm,
    marketplacePublishedAt: publishedAt,
    marketplaceVisibleAt: visibility.marketplaceVisibleAt,
    preferredDate: enquiry.preferredDate || "",
    preferredSlot: enquiry.preferredSlot || "",
    priority: enquiry.priority || "normal",
    leadIntent: enquiry.leadIntent || "not_assessed",
    sourceWebsite: enquiry.sourceWebsite || "",
    customerName: enquiry.name || "",
    customerMobile: enquiry.mobile || "",
    customerEmail: enquiry.email || "",
    customerAddress: enquiry.addressLine || "",
    providerName: provider.name || "",
    providerBusinessName: provider.businessName || "",
    providerMobile: provider.mobile || "",
    additionalDetails: enquiry.additionalDetails || {},
    maxProviderUnlocks: maxProviderUnlocks(enquiry),
    updatedAt: new Date(),
  };
}

function presentMarketplaceEnquiry(enquiry = {}, provider = {}, existing = null) {
  const visibility = visibilityForEnquiry(enquiry, provider);
  return {
    ...offerData(enquiry, provider, visibility),
    leadDistributionId: existing?.leadDistributionId || marketplaceLeadId(enquiry.enquiryId || enquiry.id),
    status: existing?.contactUnlocked ? "unlocked" : "offered",
    contactUnlocked: existing?.contactUnlocked === true,
    unlockedAt: existing?.unlockedAt || null,
    unlockMethod: existing?.unlockMethod || "",
    distributedAt: existing?.distributedAt || visibility.marketplacePublishedAt,
    createdAt: existing?.createdAt || enquiry.createdAt || visibility.marketplacePublishedAt,
    marketplaceUnlockedCount: unlockedCount(enquiry),
    marketplaceConfirmedCount: Number(enquiry.providerConfirmedCount || 0),
    marketplaceLeadIntent: enquiry.leadIntent || "not_assessed",
    marketplaceBaseCredits: leadCostCredits(enquiry),
  };
}

async function findMarketplaceEnquiry(identifier, session = null) {
  const enquiryId = marketplaceEnquiryId(identifier);
  if (!enquiryId) return null;
  let query = Enquiry.findOne(enquiryQuery(enquiryId));
  if (session) query = query.session(session);
  return query.lean();
}

async function ensureMarketplaceOffer(provider = {}, identifier, { session = null } = {}) {
  const enquiry = await findMarketplaceEnquiry(identifier, session);
  if (!enquiry) return null;
  const providerId = providerIdentity(provider);
  const enquiryId = String(enquiry.enquiryId || enquiry.id || "").trim();

  let existingQuery = LeadDistribution.findOne({ enquiryId, providerId });
  if (session) existingQuery = existingQuery.session(session);
  let existing = await existingQuery;
  if (existing?.contactUnlocked || existing?.status === "unlocked") return existing;

  const visibility = assertMarketplaceEligibility(provider, enquiry);
  const data = offerData(enquiry, provider, visibility);
  if (existing) {
    Object.assign(existing, data, {
      status: "offered",
      contactUnlocked: false,
    });
    await existing.save({ session: session || undefined });
    return existing;
  }

  const payload = {
    ...data,
    leadDistributionId: uuid(),
    status: "offered",
    contactUnlocked: false,
    distributedBy: "marketplace_dynamic",
    distributedAt: visibility.marketplacePublishedAt || new Date(),
  };

  try {
    const documents = await LeadDistribution.create([payload], { session: session || undefined });
    return documents[0];
  } catch (error) {
    if (error?.code !== 11000) throw error;
    let duplicateQuery = LeadDistribution.findOne({ enquiryId, providerId });
    if (session) duplicateQuery = duplicateQuery.session(session);
    return duplicateQuery;
  }
}

module.exports = {
  DEFAULT_MAX_PROVIDER_UNLOCKS,
  MARKETPLACE_PREFIX,
  MARKETPLACE_STATUSES,
  assertMarketplaceEligibility,
  availableUnlockSlots,
  ensureMarketplaceOffer,
  hasCoordinates,
  isMarketplaceStatus,
  marketplaceEnquiryId,
  marketplaceLeadId,
  maxProviderUnlocks,
  offerData,
  presentMarketplaceEnquiry,
  remainingUnlocks,
  unlockedCount,
  visibilityForEnquiry,
};
