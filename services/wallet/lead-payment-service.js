const Razorpay = require("razorpay");
const Enquiry = require("../../models/Enquiry");
const PaymentOrder = require("../../models/PaymentOrder");
const Provider = require("../../models/Provider");
const ProviderLeadUnlock = require("../../models/ProviderLeadUnlock");
const uuid = require("../../utils/uuid");
const { providerIdentity, providerQuery, presentProvider } = require("../../utils/provider");
const { leadCostCredits, paiseFromCredits } = require("../../utils/credits");
const { presentLead } = require("../../utils/lead");
const { withTransaction } = require("../../utils/transaction");
const { directPaymentQuote } = require("../../config/plans");
const { activeReservationKey } = require("../../utils/lead-unlock-key");
const creditService = require("../billing/credit-service");
const crmService = require("../integration/crm-service");
const marketplaceService = require("../marketplace/marketplace-service");
const leadService = require("../lead/lead-service");

const RESERVATION_MINUTES = Math.min(60, Math.max(5, Number(process.env.LEAD_PAYMENT_RESERVATION_MINUTES || 20)));
const RELEASE_BATCH_SIZE = Math.min(100, Math.max(5, Number(process.env.LEAD_PAYMENT_RELEASE_BATCH_SIZE || 25)));

function getGateway() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw Object.assign(new Error("Razorpay payments are not configured"), {
      status: 503,
      code: "RAZORPAY_NOT_CONFIGURED",
    });
  }
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

function checkoutProvider(provider = {}) {
  return {
    name: provider.name || provider.businessName || "Provider",
    email: provider.email || "",
    mobile: provider.mobile || "",
  };
}

function presentOrder(order = {}) {
  return {
    paymentOrderId: order.paymentOrderId || "",
    purpose: order.purpose || "lead_unlock",
    enquiryId: order.enquiryId || "",
    amountPaise: Number(order.totalAmountPaise || order.amountPaise || 0),
    currency: order.currency || "INR",
    status: order.status || "created",
    fulfilled: order.fulfilled === true,
    fulfillmentStatus: order.fulfillmentStatus || "pending",
    reservationStatus: order.reservationStatus || "none",
    reservedUntil: order.reservedUntil || null,
    createdAt: order.createdAt || null,
    paidAt: order.paidAt || null,
    fulfilledAt: order.fulfilledAt || null,
  };
}

async function releaseReservation(paymentOrderId, reason = "expired") {
  return withTransaction(async (session) => {
    const now = new Date();
    const order = await PaymentOrder.findOneAndUpdate(
      {
        paymentOrderId,
        purpose: "lead_unlock",
        reservationStatus: "reserved",
        fulfilled: { $ne: true },
      },
      {
        $set: {
          reservationStatus: "released",
          fulfillmentStatus: reason === "cancelled"
            ? "cancelled"
            : (reason === "gateway_failed" ? "gateway_failed" : "reservation_released"),
          status: reason === "cancelled"
            ? "cancelled"
            : (reason === "gateway_failed" ? "failed" : "expired"),
          fulfillmentError: reason === "gateway_failed" ? "Razorpay order creation failed" : "",
          updatedAt: now,
        },
        $unset: { activeReservationKey: 1 },
      },
      { new: true, session },
    );
    if (!order) return { released: false, counterAdjusted: false };

    const enquiry = await Enquiry.findOneAndUpdate(
      { enquiryId: order.enquiryId, reservedUnlockCount: { $gt: 0 } },
      {
        $inc: { reservedUnlockCount: -1, remainingUnlocks: 1 },
        $set: { updatedAt: now },
      },
      { new: true, session },
    );

    let reopened = false;
    if (
      enquiry
      && enquiry.status === "approved"
      && enquiry.isActive !== false
      && Number(enquiry.remainingUnlocks || 0) > 0
      && enquiry.marketplaceClosureReason === "unlock_limit"
      && enquiry.marketplaceExpiresAt
      && new Date(enquiry.marketplaceExpiresAt) > now
    ) {
      const result = await Enquiry.updateOne(
        {
          enquiryId: enquiry.enquiryId,
          status: "approved",
          isActive: { $ne: false },
          remainingUnlocks: { $gt: 0 },
          marketplaceClosureReason: "unlock_limit",
          marketplaceExpiresAt: { $gt: now },
        },
        {
          $set: {
            marketplaceAvailable: true,
            marketplaceStatus: "published",
            marketplaceClosureReason: "",
            updatedAt: now,
          },
        },
        { session },
      );
      reopened = Boolean(result.matchedCount);
    }

    return {
      released: true,
      counterAdjusted: Boolean(enquiry),
      reopened,
      order: order.toObject(),
      enquiry: enquiry?.toObject() || null,
    };
  });
}

async function releaseExpiredReservations(filters = {}) {
  const query = {
    purpose: "lead_unlock",
    reservationStatus: "reserved",
    fulfilled: { $ne: true },
    reservedUntil: { $lte: new Date() },
  };
  if (filters.providerId) query.providerId = filters.providerId;
  if (filters.enquiryId) query.enquiryId = filters.enquiryId;
  const rows = await PaymentOrder.find(query)
    .select({ paymentOrderId: 1 })
    .sort({ reservedUntil: 1, _id: 1 })
    .limit(RELEASE_BATCH_SIZE)
    .lean();
  let released = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await releaseReservation(row.paymentOrderId, "expired");
      if (result.released) released += 1;
    } catch (error) {
      failed += 1;
    }
  }
  return { scanned: rows.length, released, failed };
}

async function createRazorpayOrder(provider, paymentOrderId, amountPaise, enquiryId) {
  const receipt = `lead_${paymentOrderId}`;
  const order = await getGateway().orders.create({
    amount: amountPaise,
    currency: "INR",
    receipt,
    notes: {
      providerId: providerIdentity(provider),
      paymentOrderId,
      purpose: "lead_unlock",
      enquiryId,
    },
  });
  if (!order?.id || Number(order.amount) !== Number(amountPaise) || String(order.currency || "").toUpperCase() !== "INR") {
    throw Object.assign(new Error("Razorpay returned an invalid order"), {
      status: 502,
      code: "RAZORPAY_ORDER_INVALID",
    });
  }
  return { order, receipt };
}

function orderResponse(order, provider, enquiry, quote, reused = false) {
  return {
    keyId: process.env.RAZORPAY_KEY_ID,
    paymentOrderId: order.paymentOrderId,
    razorpayOrderId: order.razorpayOrderId,
    amountPaise: Number(order.totalAmountPaise || order.amountPaise),
    currency: order.currency || "INR",
    quote: {
      subtotalPaise: Number(order.subtotalPaise || quote?.subtotalPaise || 0),
      gstAmountPaise: Number(order.gstAmountPaise || quote?.gstAmountPaise || 0),
      totalAmountPaise: Number(order.totalAmountPaise || order.amountPaise || quote?.totalAmountPaise || 0),
      gstRatePercent: Number(order.gstRatePercent || quote?.gstRatePercent || 18),
      baseCredits: Number(order.baseLeadCostCredits ?? leadCostCredits(enquiry)),
      effectiveCredits: Number(order.effectiveLeadCostCredits ?? leadCostCredits(enquiry)),
      discountPercent: 0,
      previousUnlocks: Number(order.unlockCountAtPurchase ?? enquiry.unlockedCount ?? 0),
    },
    lead: {
      enquiryId: enquiry.enquiryId,
      recordId: enquiry.enquiryId,
      title: enquiry.requirementTitle || enquiry.serviceType || "Lead unlock",
    },
    provider: checkoutProvider(provider),
    reservedUntil: order.reservedUntil || null,
    reused,
  };
}

async function createLeadOrder(provider, enquiryIdInput) {
  const providerId = providerIdentity(provider);
  const enquiryId = marketplaceService.publicId(enquiryIdInput);
  await releaseExpiredReservations({ providerId, enquiryId });
  const existingUnlock = await ProviderLeadUnlock.findOne({ providerId, enquiryId }).select({ providerLeadUnlockId: 1 }).lean();
  if (existingUnlock) {
    throw Object.assign(new Error("This lead is already unlocked"), { status: 409, code: "LEAD_ALREADY_UNLOCKED" });
  }

  const syncedProvider = await creditService.syncCredits(providerId);
  const enquiry = await marketplaceService.loadMarketplaceEnquiry(provider, enquiryId);
  const costCredits = Math.max(0, leadCostCredits(enquiry));
  const costMinorCredits = paiseFromCredits(costCredits);
  if (Number(syncedProvider.walletBalancePaise || 0) >= costMinorCredits) {
    throw Object.assign(new Error("You have enough credits. Unlock this lead using credits."), {
      status: 409,
      code: "CREDITS_AVAILABLE",
    });
  }

  const key = activeReservationKey(providerId, enquiryId);
  const existing = await PaymentOrder.findOne({
    activeReservationKey: key,
    reservationStatus: "reserved",
    fulfilled: { $ne: true },
    reservedUntil: { $gt: new Date() },
  }).lean();
  const quote = directPaymentQuote(costMinorCredits);
  if (existing) {
    if (existing.status === "gateway_pending") {
      throw Object.assign(new Error("Your secure checkout is being prepared. Try again in a moment."), {
        status: 409,
        code: "CHECKOUT_PREPARING",
      });
    }
    return orderResponse(existing, provider, enquiry, quote, true);
  }
  if (quote.totalAmountPaise < 100) {
    throw Object.assign(new Error("This lead does not require direct payment"), {
      status: 400,
      code: "DIRECT_PAYMENT_NOT_REQUIRED",
    });
  }

  const paymentOrderId = uuid();
  const reservedUntil = new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000);
  let reservedOrder;

  try {
    reservedOrder = await withTransaction(async (session) => {
      const unlockedDuringCheckout = await ProviderLeadUnlock.findOne({ providerId, enquiryId })
        .select({ providerLeadUnlockId: 1 })
        .session(session)
        .lean();
      if (unlockedDuringCheckout) {
        throw Object.assign(new Error("This lead is already unlocked"), {
          status: 409,
          code: "LEAD_ALREADY_UNLOCKED",
        });
      }

      const claimed = await Enquiry.findOneAndUpdate(
        {
          enquiryId,
          marketplaceAvailable: true,
          marketplaceStatus: "published",
          marketplaceExpiresAt: { $gt: new Date() },
          remainingUnlocks: { $gt: 0 },
        },
        {
          $inc: { remainingUnlocks: -1, reservedUnlockCount: 1 },
          $set: { updatedAt: new Date() },
        },
        { new: true, session },
      );
      if (!claimed) {
        throw Object.assign(new Error("This lead has reached its provider unlock limit"), {
          status: 409,
          code: "LEAD_UNLOCK_LIMIT_REACHED",
        });
      }
      await marketplaceService.closeIfFull(claimed, session);
      const [paymentOrder] = await PaymentOrder.create([{
        paymentOrderId,
        providerId,
        purpose: "lead_unlock",
        // A unique local placeholder prevents duplicate gateway orders while
        // the external Razorpay order is being prepared.
        razorpayOrderId: `pending_${paymentOrderId}`,
        amountPaise: quote.totalAmountPaise,
        listedPricePaise: quote.subtotalPaise,
        subtotalPaise: quote.subtotalPaise,
        gstAmountPaise: quote.gstAmountPaise,
        totalAmountPaise: quote.totalAmountPaise,
        gstRatePercent: quote.gstRatePercent,
        gstIncluded: false,
        enquiryId,
        baseLeadCostCredits: costCredits,
        effectiveLeadCostCredits: costCredits,
        unlockDiscountPercent: 0,
        unlockCountAtPurchase: Number(claimed.unlockedCount || 0),
        currency: "INR",
        status: "gateway_pending",
        fulfillmentStatus: "pending",
        reservationStatus: "reserved",
        reservedUntil,
        activeReservationKey: key,
      }], { session });
      return paymentOrder.toObject();
    });
  } catch (error) {
    if (error?.code === 11000) {
      const duplicate = await PaymentOrder.findOne({ activeReservationKey: key, reservationStatus: "reserved" }).lean();
      if (duplicate?.status === "gateway_pending") {
        throw Object.assign(new Error("Your secure checkout is being prepared. Try again in a moment."), {
          status: 409,
          code: "CHECKOUT_PREPARING",
        });
      }
      if (duplicate) return orderResponse(duplicate, provider, enquiry, quote, true);
    }
    throw error;
  }

  let gatewayOrder;
  try {
    gatewayOrder = await createRazorpayOrder(provider, paymentOrderId, quote.totalAmountPaise, enquiryId);
  } catch (error) {
    await releaseReservation(paymentOrderId, "gateway_failed").catch(() => {});
    throw error;
  }

  const readyOrder = await PaymentOrder.findOneAndUpdate(
    {
      paymentOrderId: reservedOrder.paymentOrderId,
      reservationStatus: "reserved",
      status: "gateway_pending",
    },
    {
      $set: {
        razorpayOrderId: gatewayOrder.order.id,
        receipt: gatewayOrder.receipt,
        status: "created",
        updatedAt: new Date(),
      },
    },
    { new: true },
  ).lean();

  if (!readyOrder) {
    throw Object.assign(new Error("The checkout reservation ended before Razorpay was ready. Start again."), {
      status: 409,
      code: "CHECKOUT_RESERVATION_ENDED",
    });
  }
  return orderResponse(readyOrder, provider, enquiry, quote, false);
}

async function cancelLeadOrder(provider, enquiryIdInput, input = {}) {
  const providerId = providerIdentity(provider);
  const enquiryId = marketplaceService.publicId(enquiryIdInput);
  const paymentOrderId = String(input.paymentOrderId || "").trim();
  const order = await PaymentOrder.findOne({
    providerId,
    enquiryId,
    purpose: "lead_unlock",
    ...(paymentOrderId ? { paymentOrderId } : { reservationStatus: "reserved" }),
  }).sort({ createdAt: -1 }).lean();
  if (!order || order.fulfilled) return { cancelled: false };
  const result = await releaseReservation(order.paymentOrderId, "cancelled");
  return { cancelled: result.released };
}

async function syncUnlock(unlock, provider) {
  try {
    const response = await crmService.sendProviderUnlock({
      providerLeadUnlockId: unlock.providerLeadUnlockId,
      enquiryId: unlock.enquiryId,
      providerId: unlock.providerId,
      providerName: provider.businessName || provider.name || "",
      unlockMethod: "direct_payment",
      creditsUsed: unlock.chargedCredits,
      unlockedAt: unlock.unlockedAt,
      eventAt: unlock.unlockedAt,
    });
    await ProviderLeadUnlock.updateOne(
      { providerLeadUnlockId: unlock.providerLeadUnlockId },
      { $set: {
        crmSyncStatus: response.skipped || response.deliveryFailed ? "pending" : "synced",
        crmSyncError: response.reason || response.deliveryWarning || "",
        crmSyncUpdatedAt: new Date(),
      } },
    );
  } catch (error) {
    await ProviderLeadUnlock.updateOne(
      { providerLeadUnlockId: unlock.providerLeadUnlockId },
      { $set: { crmSyncStatus: "failed", crmSyncError: String(error.message || "CRM sync failed").slice(0, 1000), crmSyncUpdatedAt: new Date() } },
    );
  }
}

async function fulfillLeadOrder(paymentOrderInput, paymentId) {
  const paymentOrder = paymentOrderInput.toObject ? paymentOrderInput.toObject() : paymentOrderInput;
  if (paymentOrder.fulfilled) {
    const existing = await ProviderLeadUnlock.findOne({ providerId: paymentOrder.providerId, enquiryId: paymentOrder.enquiryId }).lean();
    const enquiry = existing ? await Enquiry.findOne({ enquiryId: existing.enquiryId }).lean() : null;
    return {
      status: "completed",
      purpose: "lead_unlock",
      lead: existing && enquiry ? presentLead(enquiry, existing) : null,
      paymentOrder: presentOrder(paymentOrder),
      duplicate: true,
    };
  }

  const result = await withTransaction(async (session) => {
    const order = await PaymentOrder.findOne({ paymentOrderId: paymentOrder.paymentOrderId }).session(session);
    if (!order) throw Object.assign(new Error("Payment order not found"), { status: 404 });
    if (order.fulfilled) {
      const unlock = await ProviderLeadUnlock.findOne({ providerId: order.providerId, enquiryId: order.enquiryId }).session(session);
      const enquiry = unlock ? await Enquiry.findOne({ enquiryId: order.enquiryId }).session(session) : null;
      return { duplicate: true, order: order.toObject(), unlock: unlock?.toObject() || null, enquiry: enquiry?.toObject() || null, provider: null };
    }

    const provider = await Provider.findOne({ ...providerQuery(order.providerId), status: "active", portalAccessEnabled: { $ne: false } }).session(session);
    if (!provider) {
      throw Object.assign(new Error("Provider account is not eligible"), { status: 409, code: "PROVIDER_INELIGIBLE" });
    }
    const existingUnlock = await ProviderLeadUnlock.findOne({ providerId: order.providerId, enquiryId: order.enquiryId }).session(session);
    if (existingUnlock) {
      if (order.reservationStatus === "reserved") {
        await Enquiry.updateOne(
          { enquiryId: order.enquiryId, reservedUnlockCount: { $gt: 0 } },
          { $inc: { reservedUnlockCount: -1, remainingUnlocks: 1 }, $set: { updatedAt: new Date() } },
          { session },
        );
      }
      order.status = "paid";
      order.razorpayPaymentId = paymentId;
      order.signatureVerified = true;
      order.fulfilled = true;
      order.fulfillmentStatus = "completed";
      order.fulfillmentReferenceId = existingUnlock.providerLeadUnlockId;
      order.reservationStatus = "converted";
      order.activeReservationKey = undefined;
      order.paidAt = order.paidAt || new Date();
      order.fulfilledAt = new Date();
      await order.save({ session });
      const enquiry = await Enquiry.findOne({ enquiryId: order.enquiryId }).session(session);
      return { duplicate: true, order: order.toObject(), unlock: existingUnlock.toObject(), enquiry: enquiry?.toObject() || null, provider: provider.toObject() };
    }

    let enquiry;
    if (order.reservationStatus === "reserved") {
      enquiry = await Enquiry.findOneAndUpdate(
        { enquiryId: order.enquiryId, reservedUnlockCount: { $gt: 0 } },
        { $inc: { reservedUnlockCount: -1, unlockedCount: 1 }, $set: { updatedAt: new Date() } },
        { new: true, session },
      );
    } else {
      enquiry = await Enquiry.findOneAndUpdate(
        {
          enquiryId: order.enquiryId,
          marketplaceExpiresAt: { $gt: new Date() },
          remainingUnlocks: { $gt: 0 },
        },
        { $inc: { remainingUnlocks: -1, unlockedCount: 1 }, $set: { updatedAt: new Date() } },
        { new: true, session },
      );
    }
    if (!enquiry) {
      throw Object.assign(new Error("This paid lead requires manual review because no unlock slot is available"), {
        status: 409,
        code: "PAID_LEAD_REVIEW_REQUIRED",
      });
    }

    const [unlock] = await ProviderLeadUnlock.create([
      leadService.unlockSnapshot(enquiry.toObject(), provider.toObject(), {
        unlockMethod: "direct_payment",
        chargedCredits: Number(order.effectiveLeadCostCredits || leadCostCredits(enquiry)),
        chargedPaise: Number(order.totalAmountPaise || order.amountPaise || 0),
        paymentOrderId: order.paymentOrderId,
      }),
    ], { session });

    await marketplaceService.closeIfFull(enquiry, session);

    order.status = "paid";
    order.razorpayPaymentId = paymentId;
    order.signatureVerified = true;
    order.fulfilled = true;
    order.fulfillmentStatus = "completed";
    order.fulfillmentReferenceId = unlock.providerLeadUnlockId;
    order.reservationStatus = "converted";
    order.activeReservationKey = undefined;
    order.paidAt = order.paidAt || new Date();
    order.fulfilledAt = new Date();
    await order.save({ session });
    return { duplicate: false, order: order.toObject(), unlock: unlock.toObject(), enquiry: enquiry.toObject(), provider: provider.toObject() };
  });

  if (result.unlock && !result.duplicate) syncUnlock(result.unlock, result.provider).catch(() => {});
  return {
    status: "completed",
    purpose: "lead_unlock",
    lead: result.unlock && result.enquiry ? presentLead(result.enquiry, result.unlock, marketplaceService.visibilityFor(result.provider || {}, result.enquiry)) : null,
    provider: result.provider ? presentProvider(result.provider) : null,
    paymentOrder: presentOrder(result.order),
    duplicate: result.duplicate,
  };
}

module.exports = {
  RESERVATION_MINUTES,
  RELEASE_BATCH_SIZE,
  activeReservationKey,
  presentOrder,
  releaseReservation,
  releaseExpiredReservations,
  createLeadOrder,
  cancelLeadOrder,
  fulfillLeadOrder,
};
