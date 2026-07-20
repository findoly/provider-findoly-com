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

function numericFilter(value) {
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

async function list(provider, filters = {}) {
  const providerId = providerIdentity(provider);
  const categories = providerCategories(provider);
  const { page, limit, skip } = getPagination(filters);
  const status = enumFilter(filters.status || "offered", ["offered", "unlocked"]);
  if (!status) {
    throw Object.assign(new Error("Invalid lead status filter"), {
      status: 400,
      code: "FILTER_INVALID",
    });
  }

  const query = { providerId };
  const conditions = [];

  if (status === "unlocked") {
    query.contactUnlocked = true;
  } else {
    query.status = "offered";
    query.contactUnlocked = { $ne: true };
    query.categorySlug = { $in: categories };
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

  const pincode = String(filters.pincode || "").trim();
  if (pincode) query.pincode = new RegExp(`^${escapeRegex(pincode)}`, "i");

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

  const dateField = status === "unlocked" ? "unlockedAt" : "distributedAt";
  const start = dateAt(filters.startDate);
  const end = dateAt(filters.endDate, true);
  const relativeStart = ageCutoff(filters.age);
  if (start || end || relativeStart) {
    query[dateField] = {};
    if (relativeStart) query[dateField].$gte = relativeStart;
    if (start) query[dateField].$gte = start;
    if (end) query[dateField].$lte = end;
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

  if (status === "unlocked") {
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
      query.unlockedAt = { ...(query.unlockedAt || {}), $ne: null };
      if (!query.unlockedAt.$lte || query.unlockedAt.$lte > overdueCutoff) query.unlockedAt.$lte = overdueCutoff;
      conditions.push({
        $and: [
          { $or: [{ providerSaleOutcome: "" }, { providerSaleOutcome: { $exists: false } }] },
          { providerLeadStatus: { $ne: "confirmed" } },
        ],
      });
    }
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

  const sort = listSort(status, filters.sort);
  const [rows, total] = await Promise.all([
    LeadDistribution.find(query)
      .sort(sort)
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
    const result = await withTransaction(async (session) => {
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
      return {
        lead: (await presentRows([unlocked], session))[0],
        notifyCommunication: true,
        eventPayload: {
          leadDistributionId: unlocked.leadDistributionId || leadDistributionId,
          enquiryId: unlocked.enquiryId || unlocked.requirementId,
          providerId,
          providerName:
            unlocked.providerBusinessName ||
            unlocked.providerName ||
            provider.businessName ||
            provider.name ||
            "",
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
