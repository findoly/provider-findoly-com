const LeadDistribution = require("../../models/LeadDistribution");
const { providerIdentity, presentProvider } = require("../../utils/provider");
const { presentLead } = require("../../utils/lead");

async function get(provider) {
  const providerId = providerIdentity(provider);
  const categorySlugs = Array.isArray(provider.categorySlugs)
    ? provider.categorySlugs
    : [];

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
    provider: presentProvider(provider),
    offered,
    unlocked,
    recent: recent.map(presentLead),
  };
}

module.exports = { get };
