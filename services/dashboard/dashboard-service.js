const ProviderLeadUnlock = require("../../models/ProviderLeadUnlock");
const { providerIdentity, providerCategories, presentProvider } = require("../../utils/provider");
const { presentLead } = require("../../utils/lead");
const creditService = require("../billing/credit-service");
const leadService = require("../lead/lead-service");
const marketplaceService = require("../marketplace/marketplace-service");

const CACHE_TTL_MS = Math.min(120000, Math.max(5000, Number(process.env.PROVIDER_DASHBOARD_CACHE_TTL_MS || 30000)));
const COUNT_CAP = Math.min(5000, Math.max(100, Number(process.env.PROVIDER_DASHBOARD_COUNT_CAP || 1000)));
const cache = new Map();

async function boundedCount(Model, query, cap = COUNT_CAP) {
  const rows = await Model.find(query)
    .select({ _id: 1 })
    .sort({ _id: -1 })
    .limit(cap + 1)
    .lean();
  return { value: Math.min(rows.length, cap), capped: rows.length > cap };
}

function cacheKey(provider) {
  return `${providerIdentity(provider)}:${providerCategories(provider).sort().join(",")}`;
}

async function activitySnapshot(provider) {
  const providerId = providerIdentity(provider);
  const categorySlugs = providerCategories(provider);

  const [
    available,
    unlocked,
    followUp,
    confirmed,
    pendingOutcomeCount,
    marketplacePage,
    unlockedPage,
    pendingOutcomeResult,
  ] = await Promise.all([
    categorySlugs.length ? marketplaceService.countMarketplace(provider, { cap: COUNT_CAP }) : { value: 0, capped: false },
    boundedCount(ProviderLeadUnlock, { providerId }),
    boundedCount(ProviderLeadUnlock, { providerId, providerLeadStatus: "follow_up" }),
    boundedCount(ProviderLeadUnlock, { providerId, providerSaleOutcome: "confirmed" }),
    boundedCount(ProviderLeadUnlock, { providerId, providerSaleOutcome: "" }),
    categorySlugs.length ? marketplaceService.listMarketplace(provider, { limit: 4, sort: "newest" }) : { data: [] },
    leadService.listUnlocked(provider, { limit: 4, sort: "newest" }),
    leadService.pendingOutcomes(provider, { limit: 10, sort: "oldest" }),
  ]);

  const unlockedRecent = unlockedPage.data || [];
  const marketplaceRecent = (marketplacePage.data || []).map((lead) =>
    presentLead(lead, null, marketplaceService.visibilityFor(provider, lead)));
  const recent = [...unlockedRecent, ...marketplaceRecent]
    .sort((left, right) => {
      const leftDate = new Date(left.unlockedAt || left.marketplacePublishedAt || left.createdAt || 0).getTime();
      const rightDate = new Date(right.unlockedAt || right.marketplacePublishedAt || right.createdAt || 0).getTime();
      return rightDate - leftDate;
    })
    .slice(0, 8);

  return {
    offered: available.value,
    offeredCapped: available.capped,
    unlocked: unlocked.value,
    unlockedCapped: unlocked.capped,
    followUp: followUp.value,
    followUpCapped: followUp.capped,
    confirmed: confirmed.value,
    confirmedCapped: confirmed.capped,
    recent,
    pendingOutcomes: pendingOutcomeResult.data || [],
    pendingOutcomeCount: pendingOutcomeCount.value,
    pendingOutcomeCountCapped: pendingOutcomeCount.capped,
    pendingOutcomeHasMore: Boolean(pendingOutcomeResult.pagination?.hasNext),
  };
}

async function get(provider) {
  const providerId = providerIdentity(provider);
  const syncedProvider = await creditService.syncCredits(providerId);
  const key = cacheKey(provider);
  const cached = cache.get(key);
  let snapshot;
  if (cached && cached.expiresAt > Date.now()) {
    snapshot = cached.value;
  } else {
    snapshot = await activitySnapshot(provider);
    cache.set(key, { value: snapshot, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return { provider: presentProvider(syncedProvider), ...snapshot };
}

function clearDashboardCache(providerId = "") {
  if (!providerId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${providerId}:`)) cache.delete(key);
  }
}

module.exports = { get, clearDashboardCache, boundedCount };
