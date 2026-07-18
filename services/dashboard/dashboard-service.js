const LeadDistribution = require("../../models/LeadDistribution");
const {
  providerIdentity,
  providerCategories,
  presentProvider,
} = require("../../utils/provider");
const { presentLead } = require("../../utils/lead");
const creditService = require("../billing/credit-service");
const leadService = require("../lead/lead-service");
const { refreshProviderVisibility } = require("../marketplace/visibility-service");

async function get(provider) {
  await refreshProviderVisibility(provider);
  const providerId = providerIdentity(provider);
  const categorySlugs = providerCategories(provider);
  const syncedProvider = await creditService.syncCredits(providerId);

  const availableQuery = {
    providerId,
    status: "offered",
    contactUnlocked: { $ne: true },
    marketplaceVisibleAt: { $ne: null, $lte: new Date() },
  };
  availableQuery.categorySlug = { $in: categorySlugs };

  const [offered, unlocked, followUp, confirmed, recent, pendingOutcomeResult] = await Promise.all([
    LeadDistribution.countDocuments(availableQuery),
    LeadDistribution.countDocuments({ providerId, contactUnlocked: true }),
    LeadDistribution.countDocuments({ providerId, contactUnlocked: true, providerLeadStatus: "follow_up" }),
    LeadDistribution.countDocuments({ providerId, contactUnlocked: true, providerSaleOutcome: "confirmed" }),
    LeadDistribution.find({
      providerId,
      $or: [availableQuery, { contactUnlocked: true }],
    })
      .sort({ distributedAt: -1, createdAt: -1 })
      .limit(8)
      .lean(),
    leadService.pendingOutcomes(provider, { limit: 10 }),
  ]);

  return {
    provider: presentProvider(syncedProvider),
    offered,
    unlocked,
    followUp,
    confirmed,
    recent: await leadService.presentRows(recent),
    pendingOutcomes: pendingOutcomeResult.data,
    pendingOutcomeCount: pendingOutcomeResult.total,
    outcomeReminderDays: pendingOutcomeResult.reminderDays,
  };
}

module.exports = { get };
