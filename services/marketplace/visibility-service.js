const Enquiry = require("../../models/Enquiry");
const LeadDistribution = require("../../models/LeadDistribution");
const {
  haversineDistanceKm,
  marketplaceVisibleAt,
} = require("../../utils/marketplace-radius");
const { providerIdentity } = require("../../utils/provider");

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

function visibilityFor({ enquiry = {}, provider = {}, fallbackPublishedAt = null }) {
  if (!hasCoordinates(enquiry, "location") || !hasCoordinates(provider, "service")) {
    return {
      leadLatitude: hasCoordinates(enquiry, "location") ? Number(enquiry.locationLatitude) : null,
      leadLongitude: hasCoordinates(enquiry, "location") ? Number(enquiry.locationLongitude) : null,
      providerDistanceKm: null,
      marketplacePublishedAt: enquiry.marketplacePublishedAt || fallbackPublishedAt || null,
      marketplaceVisibleAt: null,
    };
  }

  const publishedAt = enquiry.marketplacePublishedAt || fallbackPublishedAt || new Date();
  const distance = haversineDistanceKm(
    provider.serviceLatitude,
    provider.serviceLongitude,
    enquiry.locationLatitude,
    enquiry.locationLongitude,
  );
  return {
    leadLatitude: Number(enquiry.locationLatitude),
    leadLongitude: Number(enquiry.locationLongitude),
    providerDistanceKm: distance,
    marketplacePublishedAt: publishedAt,
    marketplaceVisibleAt: marketplaceVisibleAt(publishedAt, distance),
  };
}

async function refreshProviderVisibility(provider = {}, { force = false } = {}) {
  const providerId = providerIdentity(provider);
  if (!providerId) return { updated: 0 };

  const rowQuery = {
    providerId,
    contactUnlocked: { $ne: true },
  };
  if (!force) {
    rowQuery.$or = [
      { marketplaceVisibleAt: null },
      { marketplaceVisibleAt: { $exists: false } },
      { providerDistanceKm: null },
      { providerDistanceKm: { $exists: false } },
    ];
  }

  const rows = await LeadDistribution.find(rowQuery)
    .select({ leadDistributionId: 1, enquiryId: 1, distributedAt: 1 })
    .lean();
  if (!rows.length) return { updated: 0 };

  const ids = [...new Set(rows.map((row) => String(row.enquiryId || "")).filter(Boolean))];
  const enquiries = await Enquiry.find({
    $or: [{ enquiryId: { $in: ids } }, { id: { $in: ids } }],
  })
    .select({
      enquiryId: 1,
      id: 1,
      locationLatitude: 1,
      locationLongitude: 1,
      marketplacePublishedAt: 1,
      distributedAt: 1,
    })
    .lean();
  const map = new Map(enquiries.map((item) => [String(item.enquiryId || item.id), item]));

  const operations = rows.map((row) => {
    const enquiry = map.get(String(row.enquiryId || "")) || {};
    return {
      updateOne: {
        filter: { leadDistributionId: row.leadDistributionId },
        update: {
          $set: {
            ...visibilityFor({
              enquiry,
              provider,
              fallbackPublishedAt: enquiry.distributedAt || row.distributedAt,
            }),
            updatedAt: new Date(),
          },
        },
      },
    };
  });
  if (operations.length) await LeadDistribution.bulkWrite(operations, { ordered: false });
  return { updated: operations.length };
}

module.exports = { hasCoordinates, refreshProviderVisibility, visibilityFor };
