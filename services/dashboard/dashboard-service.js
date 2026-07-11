const LeadDistribution = require('../../models/LeadDistribution');
const Provider = require('../../models/Provider');

function providerQuery(providerId) {
  return {
    $or: [
      { providerId },
      { id: providerId },
      { _id: providerId }
    ]
  };
}

function maskLead(distribution) {
  const lead = {
    ...distribution,
    leadDistributionId:
      distribution.leadDistributionId ||
      distribution.id ||
      String(distribution._id)
  };

  const unlocked = lead.contactUnlocked === true || lead.status === 'unlocked';
  if (!unlocked) {
    delete lead.customerName;
    delete lead.customerMobile;
    delete lead.customerEmail;
    delete lead.customerAddress;
    lead.contactSnapshot = null;
  }

  return lead;
}

async function get(providerId) {
  const activeOfferQuery = {
    providerId,
    status: { $in: ['offered', 'unlocked'] }
  };

  const [provider, offered, unlocked, withdrawn, recent] = await Promise.all([
    Provider.findOne(providerQuery(providerId)).lean(),
    LeadDistribution.countDocuments({ providerId, status: 'offered' }),
    LeadDistribution.countDocuments({
      providerId,
      $or: [{ contactUnlocked: true }, { status: 'unlocked' }]
    }),
    LeadDistribution.countDocuments({ providerId, status: 'withdrawn' }),
    LeadDistribution.find(activeOfferQuery)
      .sort({ distributedAt: -1, createdAt: -1 })
      .limit(8)
      .lean()
  ]);

  if (!provider) {
    throw Object.assign(new Error('Provider not found'), { status: 404 });
  }

  return {
    provider: {
      ...provider,
      providerId: provider.providerId || provider.id || String(provider._id)
    },
    offered,
    unlocked,
    withdrawn,
    recent: recent.map(maskLead)
  };
}

module.exports = { get };
