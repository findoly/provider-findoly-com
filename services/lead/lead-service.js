const Enquiry = require("../../models/Enquiry");
const ProviderLeadUnlock = require("../../models/ProviderLeadUnlock");
const PaymentOrder = require("../../models/PaymentOrder");
const WalletTransaction = require("../../models/WalletTransaction");
const uuid = require("../../utils/uuid");
const { getPagination, cursorPaginate } = require("../../utils/pagination");
const { providerIdentity, providerCategories, presentProvider } = require("../../utils/provider");
const { leadCostCredits, paiseFromCredits } = require("../../utils/credits");
const { presentLead } = require("../../utils/lead");
const { normalizeSearchText, prefixRegex } = require("../../utils/normalization");
const { assertDateRange, parseIsoDateFilter } = require("../../utils/date-filter");
const { activeReservationKey } = require("../../utils/lead-unlock-key");
const { withTransaction } = require("../../utils/transaction");
const { validateLeadFeedback } = require("../../utils/lead-status");
const creditService = require("../billing/credit-service");
const crmSyncService = require("../integration/crm-sync-service");
const marketplaceService = require("../marketplace/marketplace-service");

function whatsappActionDiagnostics(options = {}) {
  return String(options.source || "") === "whatsapp_action";
}

function logWhatsappAction(options, event, fields = {}, level = "info") {
  if (!whatsappActionDiagnostics(options)) return;
  const log = typeof console[level] === "function" ? console[level] : console.info;
  log({
    event,
    requestId: String(options.requestId || "").slice(0, 80),
    communicationId: String(options.communicationId || "").slice(0, 128),
    ...fields,
  });
}

function cleanId(value, label = "Identifier") {
  const id = String(value || "").trim();
  if (!id || id.length > 120 || /[\0\r\n]/.test(id)) {
    throw Object.assign(new Error(`${label} is invalid`), { status: 400 });
  }
  return id;
}

function applyDateRange(query, field, filters = {}) {
  const start = parseIsoDateFilter(filters.startDate);
  const end = parseIsoDateFilter(filters.endDate, { endOfDay: true });
  assertDateRange(start, end);
  if (start || end) {
    query[field] = query[field] && typeof query[field] === "object" ? query[field] : {};
    if (start) query[field].$gte = start;
    if (end) query[field].$lte = end;
  }
}

function applyCreditRange(query, filters = {}) {
  const minimum = filters.minCredits === "" || filters.minCredits === undefined
    ? null
    : Number(filters.minCredits);
  const maximum = filters.maxCredits === "" || filters.maxCredits === undefined
    ? null
    : Number(filters.maxCredits);
  if (minimum !== null && (!Number.isFinite(minimum) || minimum < 0)) {
    throw Object.assign(new Error("Minimum credits filter is invalid"), { status: 400 });
  }
  if (maximum !== null && (!Number.isFinite(maximum) || maximum < 0)) {
    throw Object.assign(new Error("Maximum credits filter is invalid"), { status: 400 });
  }
  if (minimum !== null || maximum !== null) {
    query.chargedCredits = {};
    if (minimum !== null) query.chargedCredits.$gte = minimum;
    if (maximum !== null) query.chargedCredits.$lte = maximum;
  }
}

function unlockedSort(filters = {}) {
  return String(filters.sort || "newest") === "oldest"
    ? { unlockedAt: 1, _id: 1 }
    : { unlockedAt: -1, _id: -1 };
}

function buildUnlockedQuery(providerId, filters = {}) {
  const query = { providerId };
  const category = String(filters.categorySlug || "").trim().toLowerCase();
  if (category) query.categorySlug = category;
  const city = normalizeSearchText(filters.city);
  if (city) query.cityKey = prefixRegex(city);
  const pincode = String(filters.pincode || "").trim();
  if (pincode) {
    if (!/^[1-9]\d{0,5}$/.test(pincode)) {
      throw Object.assign(new Error("PIN code filter is invalid"), { status: 400 });
    }
    query.pincode = prefixRegex(pincode);
  }
  const outcome = String(filters.outcome || "").trim().toLowerCase();
  if (outcome === "pending") query.providerSaleOutcome = "";
  else if (outcome) {
    if (!["confirmed", "not_confirmed"].includes(outcome)) {
      throw Object.assign(new Error("Outcome filter is invalid"), { status: 400 });
    }
    query.providerSaleOutcome = outcome;
  }
  const activityStatus = String(filters.activityStatus || "").trim().toLowerCase();
  if (activityStatus) query.providerLeadStatus = activityStatus;
  if (String(filters.overdue || "").toLowerCase() === "true" || filters.overdue === true) {
    query.providerSaleOutcome = "";
    query.unlockedAt = { $lte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
  }
  const search = String(filters.q || "").trim();
  if (search) {
    if (search.length > 120) throw Object.assign(new Error("Search is too long"), { status: 400 });
    const normalized = normalizeSearchText(search);
    query.$or = [
      { providerLeadUnlockId: search },
      { enquiryId: search },
      { leadTitleKey: prefixRegex(normalized) },
      { cityKey: prefixRegex(normalized) },
      { pincode: prefixRegex(normalized) },
    ];
  }
  applyDateRange(query, "unlockedAt", filters);
  applyCreditRange(query, filters);
  return query;
}

async function listUnlocked(provider, filters = {}) {
  const providerId = providerIdentity(provider);
  const { limit, cursor } = getPagination(filters);
  const result = await cursorPaginate(ProviderLeadUnlock, {
    query: buildUnlockedQuery(providerId, filters),
    sort: unlockedSort(filters),
    limit,
    cursor,
  });
  const enquiryIds = result.data.map((row) => row.enquiryId);
  const enquiries = await Enquiry.find({ enquiryId: { $in: enquiryIds } }).lean();
  const enquiryMap = new Map(enquiries.map((row) => [row.enquiryId, row]));
  return {
    ...result,
    data: result.data.map((unlock) => {
      const enquiry = enquiryMap.get(unlock.enquiryId) || {};
      return presentLead(enquiry, unlock, marketplaceService.visibilityFor(provider, enquiry));
    }),
  };
}

async function listMarketplace(provider, filters = {}) {
  const result = await marketplaceService.listMarketplace(provider, filters);
  const rows = result.data.map((lead) =>
    presentLead(lead, null, marketplaceService.visibilityFor(provider, lead)));
  return { ...result, data: rows, pagination: { ...result.pagination, returned: rows.length } };
}

async function list(provider, filters = {}) {
  const unlocked = String(filters.status || "").toLowerCase() === "unlocked";
  const result = unlocked
    ? await listUnlocked(provider, filters)
    : await listMarketplace(provider, filters);
  return {
    ...result,
    provider: presentProvider(provider),
    locationReady: Boolean(
      provider.servicePincode
      && Number.isFinite(Number(provider.serviceLatitude))
      && Number.isFinite(Number(provider.serviceLongitude)),
    ),
    categories: providerCategories(provider),
  };
}

async function findUnlock(providerId, identifier, session = null) {
  const id = cleanId(identifier, "Lead identifier");
  let query = ProviderLeadUnlock.findOne({
    providerId,
    $or: [{ providerLeadUnlockId: id }, { enquiryId: id }],
  });
  if (session) query = query.session(session);
  return query;
}

async function get(provider, identifier) {
  const providerId = providerIdentity(provider);
  const unlock = await findUnlock(providerId, identifier);
  if (unlock) {
    const enquiry = await Enquiry.findOne({ enquiryId: unlock.enquiryId }).lean();
    if (!enquiry) throw Object.assign(new Error("Lead not found"), { status: 404 });
    return presentLead(enquiry, unlock.toObject(), marketplaceService.visibilityFor(provider, enquiry));
  }
  const enquiry = await marketplaceService.loadMarketplaceEnquiry(provider, identifier);
  return presentLead(enquiry.toObject(), null, marketplaceService.visibilityFor(provider, enquiry));
}

function unlockSnapshot(enquiry, provider, input = {}) {
  return {
    providerLeadUnlockId: uuid(),
    enquiryId: enquiry.enquiryId,
    providerId: providerIdentity(provider),
    leadTitle: enquiry.requirementTitle || "",
    leadTitleKey: normalizeSearchText(enquiry.requirementTitle),
    categorySlug: enquiry.categorySlug || "",
    category: enquiry.category || "",
    serviceTypes: Array.isArray(enquiry.serviceTypes) ? enquiry.serviceTypes.slice(0, 5) : undefined,
    priority: enquiry.priority || "normal",
    city: enquiry.city || "",
    cityKey: normalizeSearchText(enquiry.city),
    state: enquiry.state || "",
    pincode: enquiry.pincode || "",
    leadPricePaise: Number(enquiry.leadPricePaise || 0),
    currency: enquiry.currency || "INR",
    providerName: provider.name || "",
    providerBusinessName: provider.businessName || "",
    unlockedAt: input.unlockedAt || new Date(),
    unlockMethod: input.unlockMethod || "credits",
    chargedCredits: Number(input.chargedCredits || 0),
    chargedPaise: Number(input.chargedPaise || 0),
    walletTransactionId: input.walletTransactionId || "",
    paymentOrderId: input.paymentOrderId || "",
    ...crmSyncService.pendingSyncFields("provider_lead_unlocked", input.unlockedAt || new Date()),
  };
}


async function syncUnlockCommunication(unlock) {
  return crmSyncService.syncById(unlock.providerLeadUnlockId, { force: true });
}

async function unlock(provider, identifier, options = {}) {
  const providerId = providerIdentity(provider);
  const enquiryId = cleanId(identifier, "Lead reference");
  const existing = await ProviderLeadUnlock.findOne({ providerId, $or: [{ providerLeadUnlockId: enquiryId }, { enquiryId }] }).lean();
  if (existing) {
    logWhatsappAction(options, "provider_whatsapp_lead_already_available", {
      providerId,
      enquiryId: existing.enquiryId || enquiryId,
    });
    const enquiry = await Enquiry.findOne({ enquiryId: existing.enquiryId }).lean();
    return presentLead(enquiry || {}, existing, marketplaceService.visibilityFor(provider, enquiry || {}));
  }

  const activeDirectPayment = await PaymentOrder.findOne({
    providerId,
    enquiryId,
    purpose: "lead_unlock",
    reservationStatus: "reserved",
    fulfilled: { $ne: true },
    reservedUntil: { $gt: new Date() },
  }).select({ paymentOrderId: 1, reservedUntil: 1 }).lean();
  if (activeDirectPayment) {
    logWhatsappAction(options, "provider_whatsapp_lead_access_decision", {
      providerId,
      enquiryId,
      decision: "direct_payment_pending",
    }, "warn");
    throw Object.assign(
      new Error("A direct-payment checkout is already reserving this lead. Complete or cancel that checkout first."),
      { status: 409, code: "DIRECT_PAYMENT_PENDING" },
    );
  }

  logWhatsappAction(options, "provider_whatsapp_credit_transaction_started", {
    providerId,
    enquiryId,
  });
  let transactionResult;
  try {
    transactionResult = await withTransaction(async (session) => {
      const activeCheckout = await PaymentOrder.findOne({
        activeReservationKey: activeReservationKey(providerId, enquiryId),
        reservationStatus: "reserved",
        fulfilled: { $ne: true },
        reservedUntil: { $gt: new Date() },
      })
        .select({ paymentOrderId: 1, reservedUntil: 1 })
        .session(session)
        .lean();
      if (activeCheckout) {
        throw Object.assign(
          new Error("A direct-payment checkout is already reserving this lead. Complete or cancel that checkout first."),
          { status: 409, code: "DIRECT_PAYMENT_PENDING" },
        );
      }

      const marketplaceLead = await marketplaceService.loadMarketplaceEnquiry(provider, enquiryId, { session, includeContact: true });
      const costCredits = Math.max(0, leadCostCredits(marketplaceLead));
      const costMinorCredits = paiseFromCredits(costCredits);
      logWhatsappAction(options, "provider_whatsapp_credit_decision", {
        providerId,
        enquiryId: marketplaceLead.enquiryId,
        requiredCredits: costCredits,
      });
      const claimed = await Enquiry.findOneAndUpdate(
        {
          enquiryId: marketplaceLead.enquiryId,
          marketplaceAvailable: true,
          marketplaceStatus: "published",
          marketplaceExpiresAt: { $gt: new Date() },
          remainingUnlocks: { $gt: 0 },
        },
        {
          $inc: { remainingUnlocks: -1, unlockedCount: 1 },
          $set: { updatedAt: new Date() },
        },
        { new: true, session },
      );
      if (!claimed) {
        throw Object.assign(new Error("This lead is no longer available"), { status: 409, code: "LEAD_UNLOCK_CONFLICT" });
      }

      const consumption = await creditService.consumeCredits(providerId, costMinorCredits, session);
      let walletTransactionId = "";
      if (costMinorCredits > 0) {
        walletTransactionId = uuid();
        await WalletTransaction.create([{
          walletTransactionId,
          providerId,
          type: "debit",
          amountPaise: costMinorCredits,
          currency: "INR",
          balanceBeforePaise: consumption.balanceBeforePaise,
          balanceAfterPaise: consumption.balanceAfterPaise,
          status: "posted",
          source: "lead_unlock",
          referenceId: claimed.enquiryId,
          idempotencyKey: `lead-unlock:${providerId}:${claimed.enquiryId}`,
          description: `Unlocked lead ${claimed.enquiryId}`,
          metadata: { consumption: consumption.consumption },
        }], { session });
      }

      const [createdUnlock] = await ProviderLeadUnlock.create([
        unlockSnapshot(claimed.toObject(), provider, {
          unlockMethod: "credits",
          chargedCredits: costCredits,
          chargedPaise: 0,
          walletTransactionId,
        }),
      ], { session });
      await crmSyncService.enqueue(
        "provider_lead_unlocked",
        createdUnlock.toObject(),
        { session, now: createdUnlock.unlockedAt || new Date() },
      );
      await marketplaceService.closeIfFull(claimed, session);
      return { enquiry: claimed.toObject(), unlock: createdUnlock.toObject(), provider: consumption.provider.toObject() };
    });
  } catch (error) {
    if (error?.code === 11000) {
      const duplicate = await ProviderLeadUnlock.findOne({ providerId, enquiryId }).lean();
      if (duplicate) {
        logWhatsappAction(options, "provider_whatsapp_credit_transaction_completed", {
          providerId,
          enquiryId,
          result: "duplicate_recovered",
          chargedCredits: Number(duplicate.chargedCredits || 0),
        });
        const enquiry = await Enquiry.findOne({ enquiryId: duplicate.enquiryId }).lean();
        return presentLead(enquiry || {}, duplicate, marketplaceService.visibilityFor(provider, enquiry || {}));
      }
    }
    logWhatsappAction(options, "provider_whatsapp_credit_transaction_rolled_back", {
      providerId,
      enquiryId,
      resultCode: String(error?.code || "TRANSACTION_FAILED"),
      status: Number(error?.status || 500),
      errorName: String(error?.name || "Error"),
      requiredCredits: Number(error?.requiredCredits || 0),
      availableCredits: Number(error?.availableCredits || 0),
    }, "error");
    throw error;
  }

  logWhatsappAction(options, "provider_whatsapp_credit_transaction_completed", {
    providerId,
    enquiryId,
    result: "committed",
    chargedCredits: Number(transactionResult.unlock?.chargedCredits || 0),
    walletTransactionCreated: Boolean(transactionResult.unlock?.walletTransactionId),
  });

  syncUnlockCommunication(transactionResult.unlock, transactionResult.enquiry, provider).catch(() => {});
  return presentLead(
    transactionResult.enquiry,
    transactionResult.unlock,
    marketplaceService.visibilityFor(provider, transactionResult.enquiry),
  );
}

async function updateFeedback(provider, identifier, input = {}) {
  const providerId = providerIdentity(provider);
  const feedback = validateLeadFeedback(input);
  const result = await withTransaction(async (session) => {
    const unlock = await findUnlock(providerId, identifier, session);
    if (!unlock) throw Object.assign(new Error("Unlocked lead not found"), { status: 404 });
    const oldConfirmed = unlock.providerSaleOutcome === "confirmed";
    const newConfirmed = feedback.outcome === "confirmed";
    const delta = Number(newConfirmed) - Number(oldConfirmed);
    const now = new Date();

    unlock.providerSaleOutcome = feedback.outcome;
    unlock.providerSaleOutcomeNote = feedback.outcomeNote;
    unlock.providerSaleOutcomeUpdatedAt = now;
    unlock.providerSaleOutcomeUpdatedBy = providerId;
    unlock.providerLeadStatus = feedback.status;
    unlock.providerLeadReason = feedback.reason;
    unlock.providerLeadNote = feedback.note;
    unlock.providerLeadStatusUpdatedAt = feedback.status ? now : null;
    unlock.providerLeadStatusUpdatedBy = feedback.status ? providerId : "";
    unlock.outcomeVerificationStatus = "pending_review";
    unlock.outcomeVerificationNote = "";
    unlock.outcomeVerifiedAt = null;
    unlock.outcomeVerifiedBy = "";
    Object.assign(unlock, crmSyncService.pendingSyncFields("provider_feedback_updated", now));
    await unlock.save({ session });
    await crmSyncService.enqueue(
      "provider_feedback_updated",
      unlock.toObject(),
      { session, now },
    );

    let enquiry = await Enquiry.findOneAndUpdate(
      { enquiryId: unlock.enquiryId },
      delta ? { $inc: { providerConfirmedCount: delta }, $set: { providerSaleConversionUpdatedAt: now, updatedAt: now } }
        : { $set: { providerSaleConversionUpdatedAt: now, updatedAt: now } },
      { new: true, session },
    );
    if (!enquiry) throw Object.assign(new Error("Lead not found"), { status: 404 });
    if (Number(enquiry.providerConfirmedCount || 0) < 0) {
      enquiry.providerConfirmedCount = 0;
    }
    enquiry.providerSaleConversionStatus = Number(enquiry.providerConfirmedCount || 0) > 0
      ? "converted"
      : "not_converted";
    enquiry.providerSaleConvertedAt = Number(enquiry.providerConfirmedCount || 0) > 0
      ? enquiry.providerSaleConvertedAt || now
      : null;
    await enquiry.save({ session });
    return { unlock: unlock.toObject(), enquiry: enquiry.toObject() };
  });

  await crmSyncService
    .syncById(result.unlock.providerLeadUnlockId, { force: true })
    .catch(() => ({ processed: false }));


  const updatedUnlock = await ProviderLeadUnlock.findOne({ providerLeadUnlockId: result.unlock.providerLeadUnlockId }).lean();
  return presentLead(result.enquiry, updatedUnlock || result.unlock, marketplaceService.visibilityFor(provider, result.enquiry));
}

async function updateStatus(provider, identifier, input = {}) {
  return updateFeedback(provider, identifier, input);
}

async function pendingOutcomes(provider, filters = {}) {
  return listUnlocked(provider, { ...filters, outcome: "pending" });
}

module.exports = {
  list,
  listMarketplace,
  listUnlocked,
  get,
  unlock,
  updateFeedback,
  updateStatus,
  pendingOutcomes,
  buildUnlockedQuery,
  unlockSnapshot,
};
