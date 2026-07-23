const LeadDistribution = require("../../models/LeadDistribution");
const WalletTransaction = require("../../models/WalletTransaction");
const Enquiry = require("../../models/Enquiry");
const uuid = require("../../utils/uuid");
const { getPagination, pageResult } = require("../../utils/pagination");
const {
  providerIdentity,
  providerCategories,
} = require("../../utils/provider");
const { presentLead } = require("../../utils/lead");
const { leadCostCredits, paiseFromCredits } = require("../../utils/credits");
const { normalizeIntent } = require("../../utils/marketplace");
const { marketplaceAgeCutoff } = require("../../utils/marketplace-radius");
const { hasCoordinates } = require("../marketplace/visibility-service");
const {
  DEFAULT_MAX_PROVIDER_UNLOCKS,
  MARKETPLACE_STATUSES,
  assertMarketplaceEligibility,
  ensureMarketplaceOffer,
  marketplaceEnquiryId,
  marketplaceLeadId,
  maxProviderUnlocks,
  presentMarketplaceEnquiry,
  remainingUnlocks,
} = require("../marketplace/offer-service");
const { validateLeadFeedback } = require("../../utils/lead-status");
const { withTransaction } = require("../../utils/transaction");
const creditService = require("../billing/credit-service");
const { releaseExpiredUnlockReservations } = require("../marketplace/reservation-service");
const crmService = require("../integration/crm-service");

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dateAt(value, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const suffix = endOfDay ? "T23:59:59.999+05:30" : "T00:00:00.000+05:30";
  const date = new Date(`${value}${suffix}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function distributionQuery(leadDistributionId) {
  return { $or: [{ leadDistributionId }, { id: leadDistributionId }] };
}

function enquiryQuery(enquiryId) {
  return { $or: [{ enquiryId }, { id: enquiryId }] };
}

async function marketplaceMap(rows = [], session = null) {
  const ids = [...new Set(rows.map((row) => String(row.enquiryId || row.requirementId || "").trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  let query = Enquiry.find({ $or: [{ enquiryId: { $in: ids } }, { id: { $in: ids } }] })
    .select({ enquiryId: 1, id: 1, unlockedCount: 1, pendingUnlockCount: 1, maxProviderUnlocks: 1, providerConfirmedCount: 1, leadIntent: 1, leadCostCredits: 1, leadPricePaise: 1, locationLatitude: 1, locationLongitude: 1, marketplacePublishedAt: 1 })
    .lean();
  if (session) query = query.session(session);
  const enquiries = await query;
  return new Map(enquiries.map((item) => [String(item.enquiryId || item.id), item]));
}

async function presentRows(rows = [], session = null) {
  const map = await marketplaceMap(rows, session);
  return rows.map((row) => {
    const item = row.toObject ? row.toObject() : { ...row };
    const enquiry = map.get(String(item.enquiryId || item.requirementId || "")) || {};
    return presentLead({
      ...item,
      marketplaceUnlockedCount: enquiry.unlockedCount,
      marketplaceConfirmedCount: enquiry.providerConfirmedCount,
      marketplaceLeadIntent: enquiry.leadIntent,
      marketplaceBaseCredits: leadCostCredits(item),
      leadLatitude: item.leadLatitude ?? enquiry.locationLatitude,
      leadLongitude: item.leadLongitude ?? enquiry.locationLongitude,
      marketplacePublishedAt: item.marketplacePublishedAt || enquiry.marketplacePublishedAt,
      maxProviderUnlocks: enquiry.maxProviderUnlocks ?? item.maxProviderUnlocks,
      pendingUnlockCount: enquiry.pendingUnlockCount ?? 0,
    });
  });
}

async function pricingForLead(lead, session = null) {
  let query = Enquiry.findOne(enquiryQuery(lead.enquiryId || lead.requirementId));
  if (session) query = query.session(session);
  const enquiry = await query.lean();
  const baseCredits = leadCostCredits(lead);
  return {
    baseCredits,
    effectiveCredits: baseCredits,
    discountPercent: 0,
    savingsCredits: 0,
    previousUnlocks: Number(enquiry?.unlockedCount || 0),
    enquiry,
    leadIntent: normalizeIntent(enquiry?.leadIntent || lead.leadIntent),
    providerConfirmedCount: Number(enquiry?.providerConfirmedCount || 0),
  };
}

async function loadLeadForProvider(provider, leadIdentifier, session = null) {
  const providerId = providerIdentity(provider);
  let query = LeadDistribution.findOne({
    providerId,
    ...distributionQuery(leadIdentifier),
  });
  if (session) query = query.session(session);
  let lead = await query;

  if (!lead && marketplaceEnquiryId(leadIdentifier)) {
    lead = await ensureMarketplaceOffer(provider, leadIdentifier, { session });
  }

  if (!lead) {
    throw Object.assign(new Error("Lead offer not found"), {
      status: 404,
      code: "LEAD_NOT_FOUND",
    });
  }

  if (lead.contactUnlocked || lead.status === "unlocked") return lead;

  const enquiryId = String(lead.enquiryId || lead.requirementId || "").trim();
  if (!enquiryId) {
    throw Object.assign(new Error("Lead offer not found"), {
      status: 404,
      code: "LEAD_NOT_FOUND",
    });
  }

  const refreshed = await ensureMarketplaceOffer(
    provider,
    marketplaceLeadId(enquiryId),
    { session },
  );
  if (!refreshed) {
    throw Object.assign(new Error("Lead offer not found"), {
      status: 404,
      code: "LEAD_NOT_FOUND",
    });
  }
  return refreshed;
}

async function claimUnlockSlot(enquiryId, session) {
  const now = new Date();
  const enquiry = await Enquiry.findOneAndUpdate(
    {
      ...enquiryQuery(enquiryId),
      $expr: marketplaceCapacityExpression(),
    },
    {
      $inc: { unlockedCount: 1 },
      $set: { updatedAt: now },
    },
    { new: true, session },
  );

  if (!enquiry) {
    throw Object.assign(new Error("This lead has reached its provider unlock limit"), {
      status: 409,
      code: "LEAD_UNLOCK_LIMIT_REACHED",
    });
  }
  return enquiry;
}

function numericFilter(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function enumFilter(value, allowed = []) {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : "";
}

function ageCutoff(value) {
  const key = enumFilter(value, ["today", "3d", "7d", "30d"]);
  if (!key) return null;
  const duration = {
    today: 24 * 60 * 60 * 1000,
    "3d": 3 * 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  }[key];
  return new Date(Date.now() - duration);
}

async function enquiryIdsForFilters(filters = {}) {
  const clauses = [];
  const intent = enumFilter(filters.leadIntent, ["not_assessed", "low", "medium", "high"]);
  if (intent) clauses.push({ leadIntent: intent });

  const confirmation = enumFilter(filters.confirmation, ["confirmed", "not_confirmed"]);
  if (confirmation === "confirmed") clauses.push({ providerConfirmedCount: { $gt: 0 } });
  if (confirmation === "not_confirmed") {
    clauses.push({
      $or: [
        { providerConfirmedCount: { $exists: false } },
        { providerConfirmedCount: { $lte: 0 } },
      ],
    });
  }

  const unlockCount = enumFilter(filters.unlockCount, ["none", "one_two", "three_plus"]);
  if (unlockCount === "none") {
    clauses.push({ $or: [{ unlockedCount: { $exists: false } }, { unlockedCount: { $lte: 0 } }] });
  }
  if (unlockCount === "one_two") clauses.push({ unlockedCount: { $gte: 1, $lte: 2 } });
  if (unlockCount === "three_plus") clauses.push({ unlockedCount: { $gte: 3 } });

  if (!clauses.length) return null;
  const rows = await Enquiry.find(clauses.length === 1 ? clauses[0] : { $and: clauses })
    .select({ enquiryId: 1, id: 1 })
    .lean();
  return [...new Set(rows.map((row) => String(row.enquiryId || row.id || "").trim()).filter(Boolean))];
}

function listSort(status, value) {
  const sort = enumFilter(value, ["newest", "oldest", "nearest", "cost_low", "cost_high"]);
  if (sort === "oldest") return status === "unlocked" ? { unlockedAt: 1, createdAt: 1 } : { distributedAt: 1, createdAt: 1 };
  if (sort === "nearest") return { providerDistanceKm: 1, distributedAt: -1 };
  if (sort === "cost_low") return { leadCostCredits: 1, leadPricePaise: 1, distributedAt: -1 };
  if (sort === "cost_high") return { leadCostCredits: -1, leadPricePaise: -1, distributedAt: -1 };
  return status === "unlocked" ? { unlockedAt: -1, createdAt: -1 } : { distributedAt: -1, createdAt: -1 };
}

function marketplaceSort(value) {
  const sort = enumFilter(value, ["newest", "oldest", "nearest", "cost_low", "cost_high"]);
  if (sort === "oldest") return { marketplacePublishedAt: 1, createdAt: 1 };
  if (sort === "cost_low") return { leadCostCredits: 1, leadPricePaise: 1, marketplacePublishedAt: -1 };
  if (sort === "cost_high") return { leadCostCredits: -1, leadPricePaise: -1, marketplacePublishedAt: -1 };
  return { marketplacePublishedAt: -1, createdAt: -1 };
}

function marketplaceCapacityExpression() {
  return {
    $lt: [
      {
        $add: [
          { $ifNull: ["$unlockedCount", 0] },
          { $ifNull: ["$pendingUnlockCount", 0] },
        ],
      },
      { $ifNull: ["$maxProviderUnlocks", DEFAULT_MAX_PROVIDER_UNLOCKS] },
    ],
  };
}

async function listMarketplace(provider, filters = {}) {
  const providerId = providerIdentity(provider);
  const categories = providerCategories(provider);
  const { page, limit, skip } = getPagination(filters);
  const locationReady = hasCoordinates(provider, "service");
  if (!categories.length) {
    return {
      ...pageResult([], 0, page, limit),
      filters: { categories, locationReady },
    };
  }

  await releaseExpiredUnlockReservations({ limit: 200 });
  const now = new Date();
  const cutoff = marketplaceAgeCutoff(now);
  const publishedRange = { $gte: cutoff, $lte: now };
  const query = {
    status: { $in: MARKETPLACE_STATUSES },
    isActive: { $ne: false },
    categorySlug: { $in: categories },
    $expr: marketplaceCapacityExpression(),
  };
  const conditions = [];

  const categorySlug = String(filters.categorySlug || "").trim();
  if (categorySlug) {
    if (!categories.includes(categorySlug)) {
      throw Object.assign(new Error("This category is not assigned to your provider account"), {
        status: 403,
        code: "CATEGORY_NOT_ASSIGNED",
      });
    }
    query.categorySlug = categorySlug;
  }

  const city = String(filters.city || "").trim();
  if (city) query.city = new RegExp(escapeRegex(city), "i");

  const pincode = String(filters.pincode || "").trim();
  if (pincode) query.pincode = new RegExp(`^${escapeRegex(pincode)}`, "i");

  const searchValue = String(filters.q || "").trim();
  if (searchValue) {
    const search = new RegExp(escapeRegex(searchValue), "i");
    conditions.push({
      $or: [
        { requirementTitle: search },
        { serviceType: search },
        { category: search },
        { city: search },
        { state: search },
        { pincode: search },
        { categorySlug: search },
        { enquiryId: search },
      ],
    });
  }

  const start = dateAt(filters.startDate);
  const end = dateAt(filters.endDate, true);
  const relativeStart = ageCutoff(filters.age);
  if (relativeStart && relativeStart > publishedRange.$gte) {
    publishedRange.$gte = relativeStart;
  }
  if (start && start > publishedRange.$gte) {
    publishedRange.$gte = start;
  }
  if (end) publishedRange.$lte = end < now ? end : now;

  // Existing distributed leads may predate the marketplacePublishedAt field.
  // Use distributedAt only as a compatibility fallback so valid leads from the
  // approved six-month window are not silently lost during rollout.
  conditions.push({
    $or: [
      { marketplacePublishedAt: publishedRange },
      {
        $and: [
          {
            $or: [
              { marketplacePublishedAt: { $exists: false } },
              { marketplacePublishedAt: null },
            ],
          },
          { distributedAt: publishedRange },
        ],
      },
    ],
  });

  const intent = enumFilter(filters.leadIntent, ["not_assessed", "low", "medium", "high"]);
  if (intent) query.leadIntent = intent;

  const confirmation = enumFilter(filters.confirmation, ["confirmed", "not_confirmed"]);
  if (confirmation === "confirmed") query.providerConfirmedCount = { $gt: 0 };
  if (confirmation === "not_confirmed") {
    conditions.push({
      $or: [
        { providerConfirmedCount: { $exists: false } },
        { providerConfirmedCount: { $lte: 0 } },
      ],
    });
  }

  const unlockCountFilter = enumFilter(filters.unlockCount, ["none", "one_two", "three_plus"]);
  if (unlockCountFilter === "none") {
    conditions.push({ $or: [{ unlockedCount: { $exists: false } }, { unlockedCount: { $lte: 0 } }] });
  }
  if (unlockCountFilter === "one_two") query.unlockedCount = { $gte: 1, $lte: 2 };
  if (unlockCountFilter === "three_plus") query.unlockedCount = { $gte: 3 };

  const minCredits = numericFilter(filters.minCredits);
  const maxCredits = numericFilter(filters.maxCredits);
  if (minCredits !== null || maxCredits !== null) {
    const creditRange = {};
    const paiseRange = {};
    if (minCredits !== null) {
      creditRange.$gte = minCredits;
      paiseRange.$gte = Math.round(minCredits * 100);
    }
    if (maxCredits !== null) {
      creditRange.$lte = maxCredits;
      paiseRange.$lte = Math.round(maxCredits * 100);
    }
    conditions.push({
      $or: [
        { leadCostCredits: creditRange },
        {
          $and: [
            { $or: [{ leadCostCredits: { $exists: false } }, { leadCostCredits: null }] },
            { leadPricePaise: paiseRange },
          ],
        },
      ],
    });
  }

  if (conditions.length) query.$and = conditions;

  const unlockedRows = await LeadDistribution.find({
    providerId,
    contactUnlocked: true,
  })
    .select({ enquiryId: 1 })
    .lean();
  const unlockedEnquiryIds = new Set(
    unlockedRows.map((row) => String(row.enquiryId || "").trim()).filter(Boolean),
  );

  const maxDistanceKm = numericFilter(filters.maxDistanceKm);
  const sortValue = enumFilter(filters.sort, ["newest", "oldest", "nearest", "cost_low", "cost_high"]) || "newest";
  const nearestRows = [];
  const pageRows = [];
  let total = 0;

  const cursor = Enquiry.find(query)
    .sort(marketplaceSort(sortValue))
    .lean()
    .cursor();

  for await (const enquiry of cursor) {
    const enquiryId = String(enquiry.enquiryId || enquiry.id || "").trim();
    if (!enquiryId || unlockedEnquiryIds.has(enquiryId)) continue;

    let visibility;
    try {
      visibility = assertMarketplaceEligibility(provider, enquiry, now);
    } catch (error) {
      if (["LEAD_NOT_AVAILABLE", "LEAD_MARKETPLACE_EXPIRED", "LEAD_NOT_FOUND", "LEAD_UNLOCK_LIMIT_REACHED", "LEAD_NOT_AVAILABLE_IN_RADIUS"].includes(error.code)) {
        continue;
      }
      throw error;
    }

    if (
      maxDistanceKm !== null
      && (!Number.isFinite(Number(visibility.providerDistanceKm)) || Number(visibility.providerDistanceKm) > maxDistanceKm)
    ) {
      continue;
    }

    const lead = presentLead(presentMarketplaceEnquiry(enquiry, provider));
    if (sortValue === "nearest") {
      nearestRows.push(lead);
      continue;
    }

    if (total >= skip && pageRows.length < limit) pageRows.push(lead);
    total += 1;
  }

  if (sortValue === "nearest") {
    nearestRows.sort((left, right) => {
      const leftDistance = Number.isFinite(Number(left.providerDistanceKm)) ? Number(left.providerDistanceKm) : Number.POSITIVE_INFINITY;
      const rightDistance = Number.isFinite(Number(right.providerDistanceKm)) ? Number(right.providerDistanceKm) : Number.POSITIVE_INFINITY;
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return new Date(right.marketplacePublishedAt || 0) - new Date(left.marketplacePublishedAt || 0);
    });
    total = nearestRows.length;
    pageRows.push(...nearestRows.slice(skip, skip + limit));
  }

  return {
    ...pageResult(pageRows, total, page, limit),
    filters: { categories, locationReady },
  };
}

async function listUnlocked(provider, filters = {}) {
  const providerId = providerIdentity(provider);
  const categories = providerCategories(provider);
  const { page, limit, skip } = getPagination(filters);
  const query = { providerId, contactUnlocked: true };
  const conditions = [];

  const categorySlug = String(filters.categorySlug || "").trim();
  if (categorySlug) query.categorySlug = categorySlug;

  const city = String(filters.city || "").trim();
  if (city) query.city = new RegExp(escapeRegex(city), "i");

  const pincode = String(filters.pincode || "").trim();
  if (pincode) query.pincode = new RegExp(`^${escapeRegex(pincode)}`, "i");

  const maxDistanceKm = numericFilter(filters.maxDistanceKm);
  if (maxDistanceKm !== null) query.providerDistanceKm = { $lte: maxDistanceKm };

  const searchValue = String(filters.q || "").trim();
  if (searchValue) {
    const search = new RegExp(escapeRegex(searchValue), "i");
    conditions.push({
      $or: [
        { leadTitle: search },
        { serviceType: search },
        { category: search },
        { city: search },
        { state: search },
        { pincode: search },
        { categorySlug: search },
        { enquiryId: search },
        { leadDistributionId: search },
      ],
    });
  }

  const start = dateAt(filters.startDate);
  const end = dateAt(filters.endDate, true);
  if (start || end) {
    query.unlockedAt = {};
    if (start) query.unlockedAt.$gte = start;
    if (end) query.unlockedAt.$lte = end;
  }

  const minCredits = numericFilter(filters.minCredits);
  const maxCredits = numericFilter(filters.maxCredits);
  if (minCredits !== null || maxCredits !== null) {
    const creditRange = {};
    const paiseRange = {};
    if (minCredits !== null) {
      creditRange.$gte = minCredits;
      paiseRange.$gte = Math.round(minCredits * 100);
    }
    if (maxCredits !== null) {
      creditRange.$lte = maxCredits;
      paiseRange.$lte = Math.round(maxCredits * 100);
    }
    conditions.push({
      $or: [
        { leadCostCredits: creditRange },
        {
          $and: [
            { $or: [{ leadCostCredits: { $exists: false } }, { leadCostCredits: null }] },
            { leadPricePaise: paiseRange },
          ],
        },
      ],
    });
  }

  const outcome = enumFilter(filters.outcome, ["pending", "confirmed", "not_confirmed"]);
  if (outcome === "confirmed") query.providerSaleOutcome = "confirmed";
  if (outcome === "not_confirmed") query.providerSaleOutcome = "not_confirmed";
  if (outcome === "pending") {
    conditions.push({
      $and: [
        { $or: [{ providerSaleOutcome: "" }, { providerSaleOutcome: { $exists: false } }] },
        { providerLeadStatus: { $ne: "confirmed" } },
      ],
    });
  }

  const activityStatus = enumFilter(filters.activityStatus, [
    "contacted", "valid", "follow_up", "on_hold", "rejected", "invalid", "not_interested", "other",
  ]);
  if (activityStatus) query.providerLeadStatus = activityStatus;

  if (String(filters.overdue || "").toLowerCase() === "true") {
    const days = Math.max(1, Number(process.env.PROVIDER_OUTCOME_REMINDER_DAYS || 7));
    const overdueCutoff = new Date(Date.now() - days * 86400000);
    query.unlockedAt = { ...(query.unlockedAt || {}), $ne: null, $lte: overdueCutoff };
    conditions.push({
      $and: [
        { $or: [{ providerSaleOutcome: "" }, { providerSaleOutcome: { $exists: false } }] },
        { providerLeadStatus: { $ne: "confirmed" } },
      ],
    });
  }

  const enquiryIds = await enquiryIdsForFilters(filters);
  if (Array.isArray(enquiryIds)) {
    if (!enquiryIds.length) {
      return {
        ...pageResult([], 0, page, limit),
        filters: { categories, locationReady: hasCoordinates(provider, "service") },
      };
    }
    query.enquiryId = { $in: enquiryIds };
  }

  if (conditions.length) query.$and = conditions;
  const sort = listSort("unlocked", filters.sort);
  const [rows, total] = await Promise.all([
    LeadDistribution.find(query).sort(sort).skip(skip).limit(limit).lean(),
    LeadDistribution.countDocuments(query),
  ]);

  return {
    ...pageResult(await presentRows(rows), total, page, limit),
    filters: { categories, locationReady: hasCoordinates(provider, "service") },
  };
}

async function list(provider, filters = {}) {
  const status = enumFilter(filters.status || "offered", ["offered", "unlocked"]);
  if (!status) {
    throw Object.assign(new Error("Invalid lead status filter"), {
      status: 400,
      code: "FILTER_INVALID",
    });
  }
  return status === "unlocked"
    ? listUnlocked(provider, filters)
    : listMarketplace(provider, filters);
}

async function get(provider, leadDistributionId) {
  const lead = await loadLeadForProvider(provider, leadDistributionId);
  return (await presentRows([lead]))[0];
}

async function unlock(provider, leadDistributionId) {
  const providerId = providerIdentity(provider);
  const categories = providerCategories(provider);

  const result = await withTransaction(async (session) => {
    const lead = await loadLeadForProvider(provider, leadDistributionId, session);

    if (lead.contactUnlocked || lead.status === "unlocked") {
      return {
        lead: (await presentRows([lead], session))[0],
        notifyCommunication: false,
      };
    }
    if (lead.status !== "offered") {
      throw Object.assign(new Error(`This lead is ${String(lead.status || "unavailable")}`), {
        status: 409,
        code: "LEAD_NOT_AVAILABLE",
      });
    }
    if (!categories.includes(lead.categorySlug)) {
      throw Object.assign(new Error("This lead no longer matches your provider categories"), {
        status: 409,
        code: "CATEGORY_MISMATCH",
      });
    }
    if (
      lead.directPaymentPendingOrderId
      && lead.directPaymentPendingUntil
      && new Date(lead.directPaymentPendingUntil) > new Date()
    ) {
      throw Object.assign(new Error("A direct payment checkout is already in progress for this lead"), {
        status: 409,
        code: "DIRECT_PAYMENT_PENDING",
      });
    }

    await releaseExpiredUnlockReservations({
      enquiryId: lead.enquiryId || lead.requirementId,
      limit: 25,
      session,
    });
    const pricing = await pricingForLead(lead, session);
    const claimedEnquiry = await claimUnlockSlot(
      lead.enquiryId || lead.requirementId,
      session,
    );
    const amountPaise = paiseFromCredits(pricing.effectiveCredits);
    const creditResult = await creditService.consumeCredits(providerId, amountPaise, session);

    let walletTransactionId = "";
    if (amountPaise > 0) {
      walletTransactionId = uuid();
      await WalletTransaction.create([
        {
          walletTransactionId,
          providerId,
          type: "debit",
          amountPaise,
          currency: lead.currency || "INR",
          balanceBeforePaise: creditResult.balanceBeforePaise,
          balanceAfterPaise: creditResult.balanceAfterPaise,
          status: "posted",
          source: "lead_unlock",
          referenceId: lead.leadDistributionId || leadDistributionId,
          idempotencyKey: `lead-unlock:${providerId}:${lead.leadDistributionId || leadDistributionId}`,
          description: `Unlocked ${lead.leadTitle || "lead"} using credits`,
          metadata: {
            enquiryId: lead.enquiryId,
            baseCredits: pricing.baseCredits,
            effectiveCredits: pricing.effectiveCredits,
            unlockPriceCredits: pricing.effectiveCredits,
            previousUnlocks: pricing.previousUnlocks,
            maxProviderUnlocks: maxProviderUnlocks(claimedEnquiry),
            allocationConsumption: creditResult.consumption,
          },
        },
      ], { session });
    }

    const now = new Date();
    const unlocked = await LeadDistribution.findOneAndUpdate(
      {
        providerId,
        leadDistributionId: lead.leadDistributionId,
        status: "offered",
        contactUnlocked: { $ne: true },
      },
      {
        $set: {
          contactUnlocked: true,
          status: "unlocked",
          unlockedAt: now,
          walletTransactionId,
          unlockMethod: "credits",
          paymentOrderId: "",
          directPaymentPendingOrderId: "",
          directPaymentPendingUntil: null,
          baseLeadCostCredits: pricing.baseCredits,
          effectiveLeadCostCredits: pricing.effectiveCredits,
          unlockDiscountPercent: 0,
          unlockCountAtPurchase: pricing.previousUnlocks,
          maxProviderUnlocks: maxProviderUnlocks(claimedEnquiry),
          leadIntent: pricing.leadIntent,
          updatedAt: now,
        },
      },
      { new: true, session },
    );

    if (!unlocked) {
      throw Object.assign(new Error("Lead unlock could not be completed"), {
        status: 409,
        code: "UNLOCK_CONFLICT",
      });
    }

    return {
      lead: (await presentRows([unlocked], session))[0],
      notifyCommunication: true,
      eventPayload: {
        leadDistributionId: unlocked.leadDistributionId || leadDistributionId,
        enquiryId: unlocked.enquiryId || unlocked.requirementId,
        providerId,
        providerName:
          unlocked.providerBusinessName
          || unlocked.providerName
          || provider.businessName
          || provider.name
          || "",
        unlockMethod: "credits",
        creditsUsed: pricing.effectiveCredits,
        unlockedAt: now.toISOString(),
        eventAt: now.toISOString(),
      },
    };
  });

  if (result.notifyCommunication) {
    try {
      const communication = await crmService.sendProviderUnlock(result.eventPayload);
      result.lead.communicationSync = communication.skipped
        ? "pending"
        : communication.deliveryFailed
          ? "partial"
          : "sent";
      if (communication.skipped) {
        result.lead.communicationWarning = communication.reason;
      } else if (communication.deliveryFailed) {
        result.lead.communicationWarning = communication.deliveryWarning;
      }
    } catch (error) {
      console.error("Provider unlock communication event failed:", error.message);
      result.lead.communicationSync = "failed";
      result.lead.communicationWarning =
        "The lead was unlocked, but its email and Slack notifications are pending retry.";
    }
  }
  return result.lead;
}

async function updateFeedback(provider, leadDistributionId, input = {}) {
  const providerId = providerIdentity(provider);
  const feedback = validateLeadFeedback(input);
  const now = new Date();
  const existing = await LeadDistribution.findOne({
    providerId,
    ...distributionQuery(leadDistributionId),
  }).lean();

  if (!existing) {
    throw Object.assign(new Error("Lead offer not found"), { status: 404, code: "LEAD_NOT_FOUND" });
  }
  if (existing.contactUnlocked !== true) {
    throw Object.assign(new Error("Unlock this lead before updating its outcome"), {
      status: 409,
      code: "LEAD_NOT_UNLOCKED",
    });
  }

  const outcomeHistory = {
    historyId: uuid(),
    fromOutcome: existing.providerSaleOutcome || (existing.providerLeadStatus === "confirmed" ? "confirmed" : ""),
    outcome: feedback.outcome,
    note: feedback.outcomeNote,
    actor: `provider:${providerId}`,
    createdAt: now,
  };
  const update = {
    $set: {
      providerSaleOutcome: feedback.outcome,
      providerSaleOutcomeNote: feedback.outcomeNote,
      providerSaleOutcomeUpdatedAt: now,
      providerSaleOutcomeUpdatedBy: providerId,
      providerLeadStatus: feedback.status,
      providerLeadReason: feedback.reason,
      providerLeadNote: feedback.note,
      providerLeadStatusUpdatedAt: feedback.status ? now : existing.providerLeadStatusUpdatedAt || null,
      providerLeadStatusUpdatedBy: feedback.status ? providerId : existing.providerLeadStatusUpdatedBy || "",
      outcomeVerificationStatus: "pending_review",
      outcomeVerificationNote: "",
      outcomeVerifiedAt: null,
      outcomeVerifiedBy: "",
      crmSyncStatus: "pending",
      crmSyncError: "",
      crmSyncUpdatedAt: now,
      updatedAt: now,
    },
    $push: { providerSaleOutcomeHistory: outcomeHistory },
  };
  if (feedback.status) {
    update.$push.providerLeadStatusHistory = {
      historyId: uuid(),
      fromStatus: existing.providerLeadStatus || "",
      status: feedback.status,
      reason: feedback.reason,
      note: feedback.note,
      actor: `provider:${providerId}`,
      createdAt: now,
    };
  }

  await LeadDistribution.updateOne({ leadDistributionId: existing.leadDistributionId }, update);

  let syncError = null;
  let syncWarning = "";
  try {
    const sync = await crmService.sendProviderFeedback({
      leadDistributionId: existing.leadDistributionId,
      enquiryId: existing.enquiryId,
      providerId,
      providerName: existing.providerBusinessName || existing.providerName || provider.businessName || provider.name || "",
      outcome: feedback.outcome,
      outcomeNote: feedback.outcomeNote,
      activityStatus: feedback.status,
      reason: feedback.reason,
      note: feedback.note,
      updatedAt: now.toISOString(),
      eventAt: now.toISOString(),
      source: "provider-portal",
    });
    syncWarning = sync.deliveryFailed ? sync.deliveryWarning : "";
    await LeadDistribution.updateOne(
      { leadDistributionId: existing.leadDistributionId },
      {
        $set: {
          crmSyncStatus: sync.skipped ? "pending" : "synced",
          crmSyncError: sync.reason || syncWarning || "",
          crmSyncUpdatedAt: new Date(),
        },
      },
    );
  } catch (error) {
    syncError = error;
    await LeadDistribution.updateOne(
      { leadDistributionId: existing.leadDistributionId },
      { $set: { crmSyncStatus: "failed", crmSyncError: String(error.message || "CRM synchronization failed").slice(0, 1000), crmSyncUpdatedAt: new Date() } },
    );
  }

  const updated = await LeadDistribution.findOne({ leadDistributionId: existing.leadDistributionId }).lean();
  const presented = (await presentRows([updated]))[0];
  if (syncError) {
    presented.syncWarning = "Your update was saved, but CRM notification is pending and will need retry.";
  } else if (syncWarning) {
    presented.syncWarning = `Your update was saved, but one communication channel failed: ${syncWarning}`;
  }
  return presented;
}

async function pendingOutcomes(provider, { limit = 25 } = {}) {
  const providerId = providerIdentity(provider);
  const days = Math.max(1, Number(process.env.PROVIDER_OUTCOME_REMINDER_DAYS || 7));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await LeadDistribution.find({
    providerId,
    contactUnlocked: true,
    unlockedAt: { $ne: null, $lte: cutoff },
    $and: [
      { $or: [{ providerSaleOutcome: "" }, { providerSaleOutcome: { $exists: false } }] },
      { providerLeadStatus: { $ne: "confirmed" } },
    ],
  })
    .sort({ unlockedAt: 1, _id: 1 })
    .limit(Math.min(100, Math.max(1, Number(limit || 25))))
    .lean();

  const data = (await presentRows(rows)).map((lead) => ({
    ...lead,
    daysPending: Math.max(days, Math.floor((Date.now() - new Date(lead.unlockedAt).getTime()) / 86400000)),
  }));
  const total = await LeadDistribution.countDocuments({
    providerId,
    contactUnlocked: true,
    unlockedAt: { $ne: null, $lte: cutoff },
    $and: [
      { $or: [{ providerSaleOutcome: "" }, { providerSaleOutcome: { $exists: false } }] },
      { providerLeadStatus: { $ne: "confirmed" } },
    ],
  });
  return { data, total, reminderDays: days };
}

module.exports = {
  get,
  list,
  pendingOutcomes,
  presentRows,
  pricingForLead,
  unlock,
  updateFeedback,
  updateStatus: updateFeedback,
};
