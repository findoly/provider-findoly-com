const LeadDistribution = require("../../models/LeadDistribution");
const {
  providerIdentity,
  providerCategories,
  presentProvider,
} = require("../../utils/provider");
const { presentLead } = require("../../utils/lead");
const creditService = require("../billing/credit-service");

async function get(provider) {
  const providerId = providerIdentity(provider);
  const categorySlugs = providerCategories(provider);
  const syncedProvider = await creditService.syncCredits(providerId);

  const availableQuery = {
    providerId,
    status: "offered",
    contactUnlocked: { $ne: true },
  };
  availableQuery.categorySlug = { $in: categorySlugs };

  const [offered, unlocked, recent] = await Promise.all([
    LeadDistribution.countDocuments(availableQuery),
    LeadDistribution.countDocuments({ providerId, contactUnlocked: true }),
    LeadDistribution.find({
      providerId,
      $or: [availableQuery, { contactUnlocked: true }],
    })
      .sort({ distributedAt: -1, createdAt: -1 })
      .limit(8)
      .lean(),
  ]);

  return {
    provider: presentProvider(syncedProvider),
    offered,
    unlocked,
    recent: recent.map(presentLead),
  };
}

module.exports = { get };
