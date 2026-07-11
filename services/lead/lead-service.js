const Provider = require("../../models/Provider");
const LeadDistribution = require("../../models/LeadDistribution");
const WalletTransaction = require("../../models/WalletTransaction");
const Enquiry = require("../../models/Enquiry");
const uuid = require("../../utils/uuid");
const { getPagination, pageResult } = require("../../utils/pagination");
const { providerIdentity, providerQuery } = require("../../utils/provider");
const { presentLead } = require("../../utils/lead");
const { withTransaction } = require("../../utils/transaction");

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
  return {
    $or: [
      { leadDistributionId },
      { id: leadDistributionId },
    ],
  };
}

function enquiryQuery(enquiryId) {
  return { $or: [{ enquiryId }, { id: enquiryId }] };
}

function providerCategories(provider) {
  return Array.isArray(provider.categorySlugs)
    ? provider.categorySlugs.filter(Boolean)
    : [];
}

async function list(provider, filters = {}) {
  const providerId = providerIdentity(provider);
  const categories = providerCategories(provider);
  const { page, limit, skip } = getPagination(filters);
  const query = { providerId };

  const status = String(filters.status || "").trim();
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
    query.$or = [
      { contactUnlocked: true },
      {
        status: "offered",
        contactUnlocked: { $ne: true },
        categorySlug: { $in: categories },
      },
    ];
  }

  const categorySlug = String(filters.categorySlug || "").trim();
  if (categorySlug) query.categorySlug = categorySlug;

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
    ...pageResult(rows.map(presentLead), total, page, limit),
    filters: {
      categories,
    },
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

  if (!lead.contactUnlocked && lead.status === "withdrawn") {
    throw Object.assign(new Error("This lead offer is no longer available"), {
      status: 410,
      code: "LEAD_WITHDRAWN",
    });
  }

  return presentLead(lead);
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
        return presentLead(lead.toObject());
      }

      if (lead.status !== "offered") {
        throw Object.assign(
          new Error(`This lead is ${String(lead.status || "unavailable")}`),
          { status: 409, code: "LEAD_NOT_AVAILABLE" },
        );
      }

      if (!categories.includes(lead.categorySlug)) {
        throw Object.assign(
          new Error("This lead no longer matches your provider categories"),
          { status: 409, code: "CATEGORY_MISMATCH" },
        );
      }

      const amountPaise = Math.max(0, Number(lead.leadPricePaise || 0));
      const currentProvider = await Provider.findOneAndUpdate(
        {
          ...providerQuery(providerId),
          status: "active",
          portalAccessEnabled: { $ne: false },
          ...(amountPaise
            ? { walletBalancePaise: { $gte: amountPaise } }
            : {}),
        },
        {
          ...(amountPaise ? { $inc: { walletBalancePaise: -amountPaise } } : {}),
          $set: { walletUpdatedAt: new Date(), updatedAt: new Date() },
        },
        { new: true, session },
      );

      if (!currentProvider) {
        throw Object.assign(
          new Error(
            amountPaise
              ? "Insufficient wallet balance"
              : "Provider account is not eligible",
          ),
          {
            status: amountPaise ? 402 : 403,
            code: amountPaise ? "INSUFFICIENT_BALANCE" : "PROVIDER_INELIGIBLE",
          },
        );
      }

      let walletTransactionId = "";
      if (amountPaise > 0) {
        walletTransactionId = uuid();
        const balanceAfterPaise = Number(currentProvider.walletBalancePaise || 0);
        await WalletTransaction.create(
          [
            {
              walletTransactionId,
              providerId,
              type: "debit",
              amountPaise,
              currency: lead.currency || "INR",
              balanceBeforePaise: balanceAfterPaise + amountPaise,
              balanceAfterPaise,
              status: "posted",
              source: "lead_unlock",
              referenceId: leadDistributionId,
              idempotencyKey: `lead-unlock:${providerId}:${leadDistributionId}`,
              description: `Unlocked ${lead.leadTitle || "lead"}`,
              metadata: { enquiryId: lead.enquiryId },
            },
          ],
          { session },
        );
      }

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
            unlockedAt: new Date(),
            walletTransactionId,
            updatedAt: new Date(),
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
        { $inc: { unlockedCount: 1 }, $set: { updatedAt: new Date() } },
        { session },
      );

      return presentLead(unlocked.toObject());
    });

    return result;
  } catch (error) {
    if (error?.code === 11000) {
      const latest = await LeadDistribution.findOne({
        providerId,
        ...distributionQuery(leadDistributionId),
      }).lean();
      if (latest?.contactUnlocked) return presentLead(latest);
    }
    throw error;
  }
}

module.exports = { list, get, unlock };
