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
const { isMarketplaceVisible } = require("../../utils/marketplace-radius");
const { hasCoordinates } = require("../marketplace/visibility-service");
const { validateLeadFeedback } = require("../../utils/lead-status");
const { withTransaction } = require("../../utils/transaction");
const creditService = require("../billing/credit-service");
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
    .select({ enquiryId: 1, id: 1, unlockedCount: 1, providerConfirmedCount: 1, leadIntent: 1, leadCostCredits: 1, leadPricePaise: 1, locationLatitude: 1, locationLongitude: 1, marketplacePublishedAt: 1 })
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

function assertMarketplaceAccess(provider, lead) {
  if (lead.contactUnlocked === true || lead.status === "unlocked") return;
  if (!hasCoordinates(provider, "service")) {
    throw Object.assign(
      new Error("Your service location is not configured in CRM. Contact Findoly support before viewing marketplace leads."),
      { status: 409, code: "PROVIDER_LOCATION_REQUIRED" },
    );
  }
  if (!isMarketplaceVisible(lead)) {
    throw Object.assign(new Error("This lead is not available in your service radius yet"), {
      status: 404,
      code: "LEAD_NOT_AVAILABLE_IN_RADIUS",
    });
  }
}

async function list(provider, filters = {}) {
  const providerId = providerIdentity(provider);
  const categories = providerCategories(provider);
  const { page, limit, skip } = getPagination(filters);
  const query = { providerId };

  const status = String(filters.status || "offered").trim();
  if (status && !["offered", "unlocked"].includes(status)) {
    throw Object.assign(new Error("Invalid lead status filter"), {
      status: 400,
      code: "FILTER_INVALID",
    });
  }

  if (status === "unlocked") {
    query.contactUnlocked = true;
  } else if (status === "offered") {
    query.status = "offered";
    query.contactUnlocked = { $ne: true };
    query.categorySlug = { $in: categories };
  } else {
    query.status = "offered";
    query.contactUnlocked = { $ne: true };
    query.categorySlug = { $in: categories };
  }
  if (status !== "unlocked") {
    query.marketplaceVisibleAt = { $ne: null, $lte: new Date() };
  }

  const categorySlug = String(filters.categorySlug || "").trim();
  if (categorySlug) {
    if (status !== "unlocked" && !categories.includes(categorySlug)) {
      throw Object.assign(new Error("This category is not assigned to your provider account"), {
        status: 403,
        code: "CATEGORY_NOT_ASSIGNED",
      });
    }
    query.categorySlug = categorySlug;
  }

  const city = String(filters.city || "").trim();
  if (city) query.city = new RegExp(escapeRegex(city), "i");

  const searchValue = String(filters.q || "").trim();
  if (searchValue) {
    const search = new RegExp(escapeRegex(searchValue), "i");
    const searchQuery = [
      { leadTitle: search },
      { serviceType: search },
      { category: search },
      { city: search },
      { categorySlug: search },
      { enquiryId: search },
      { leadDistributionId: search },
    ];
    if (query.$or) {
      query.$and = [{ $or: query.$or }, { $or: searchQuery }];
      delete query.$or;
    } else {
      query.$or = searchQuery;
    }
  }

  const start = dateAt(filters.startDate);
  const end = dateAt(filters.endDate, true);
  if (start || end) {
    query.distributedAt = {};
    if (start) query.distributedAt.$gte = start;
    if (end) query.distributedAt.$lte = end;
  }

  const [rows, total] = await Promise.all([
    LeadDistribution.find(query)
      .sort({ distributedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    LeadDistribution.countDocuments(query),
  ]);

  return {
    ...pageResult(await presentRows(rows), total, page, limit),
    filters: { categories, locationReady: hasCoordinates(provider, "service") },
  };
}

async function get(provider, leadDistributionId) {
  const providerId = providerIdentity(provider);
  const lead = await LeadDistribution.findOne({
    providerId,
    ...distributionQuery(leadDistributionId),
  }).lean();

  if (!lead) {
    throw Object.assign(new Error("Lead offer not found"), {
      status: 404,
      code: "LEAD_NOT_FOUND",
    });
  }

  if (
    !lead.contactUnlocked &&
    lead.status !== "unlocked" &&
    !providerCategories(provider).includes(lead.categorySlug)
  ) {
    throw Object.assign(new Error("Lead offer not found"), {
      status: 404,
      code: "LEAD_NOT_FOUND",
    });
  }

  if (!lead.contactUnlocked && lead.status === "withdrawn") {
    throw Object.assign(new Error("This lead offer is no longer available"), {
      status: 410,
      code: "LEAD_WITHDRAWN",
    });
  }
  assertMarketplaceAccess(provider, lead);

  return (await presentRows([lead]))[0];
}

async function unlock(provider, leadDistributionId) {
  const providerId = providerIdentity(provider);
  const categories = providerCategories(provider);

  try {
    return await withTransaction(async (session) => {
      const lead = await LeadDistribution.findOne({
        providerId,
        ...distributionQuery(leadDistributionId),
      }).session(session);

      if (!lead) {
        throw Object.assign(new Error("Lead offer not found"), {
          status: 404,
          code: "LEAD_NOT_FOUND",
        });
      }
      if (lead.contactUnlocked || lead.status === "unlocked") {
        return (await presentRows([lead], session))[0];
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
      assertMarketplaceAccess(provider, lead);
      if (
        lead.directPaymentPendingOrderId &&
        lead.directPaymentPendingUntil &&
        new Date(lead.directPaymentPendingUntil) > new Date()
      ) {
        throw Object.assign(new Error("A direct payment checkout is already in progress for this lead"), {
          status: 409,
          code: "DIRECT_PAYMENT_PENDING",
        });
      }

      const pricing = await pricingForLead(lead, session);
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
            referenceId: leadDistributionId,
            idempotencyKey: `lead-unlock:${providerId}:${leadDistributionId}`,
            description: `Unlocked ${lead.leadTitle || "lead"} using credits`,
            metadata: {
              enquiryId: lead.enquiryId,
              baseCredits: pricing.baseCredits,
              effectiveCredits: pricing.effectiveCredits,
              unlockPriceCredits: pricing.effectiveCredits,
              previousUnlocks: pricing.previousUnlocks,
              allocationConsumption: creditResult.consumption,
            },
          },
        ], { session });
      }

      const now = new Date();
      const unlocked = await LeadDistribution.findOneAndUpdate(
        {
          providerId,
          ...distributionQuery(leadDistributionId),
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

      await Enquiry.updateOne(
        enquiryQuery(lead.enquiryId || lead.requirementId),
        { $inc: { unlockedCount: 1 }, $set: { updatedAt: now } },
        { session },
      );
      return (await presentRows([unlocked], session))[0];
    });
  } catch (error) {
    if (error?.code === 11000) {
      const latest = await LeadDistribution.findOne({ providerId, ...distributionQuery(leadDistributionId) }).lean();
      if (latest?.contactUnlocked) return (await presentRows([latest]))[0];
    }
    throw error;
  }
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
    });
    await LeadDistribution.updateOne(
      { leadDistributionId: existing.leadDistributionId },
      { $set: { crmSyncStatus: sync.skipped ? "pending" : "synced", crmSyncError: sync.reason || "", crmSyncUpdatedAt: new Date() } },
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
