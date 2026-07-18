const crypto = require("crypto");
const Razorpay = require("razorpay");
const Provider = require("../../models/Provider");
const WalletTransaction = require("../../models/WalletTransaction");
const PaymentOrder = require("../../models/PaymentOrder");
const ProviderSubscription = require("../../models/ProviderSubscription");
const LeadDistribution = require("../../models/LeadDistribution");
const Enquiry = require("../../models/Enquiry");
const uuid = require("../../utils/uuid");
const { getPagination, pageResult } = require("../../utils/pagination");
const {
  providerIdentity,
  providerCategories,
  providerQuery,
  presentProvider,
} = require("../../utils/provider");
const { withTransaction } = require("../../utils/transaction");
const {
  creditsFromPaise,
  leadCostCredits,
  paiseFromCredits,
} = require("../../utils/credits");
const { presentLead } = require("../../utils/lead");
const { isMarketplaceVisible } = require("../../utils/marketplace-radius");
const { hasCoordinates } = require("../marketplace/visibility-service");
const {
  directPaymentQuote,
  getPlan,
  listPlans,
} = require("../../config/plans");
const creditService = require("../billing/credit-service");

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

function safeSignatureEqual(expected, actual) {
  const expectedBuffer = Buffer.from(String(expected || ""));
  const actualBuffer = Buffer.from(String(actual || ""));
  return (
    expectedBuffer.length === actualBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

function verifyCheckoutSignature(orderId, paymentId, signature) {
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return safeSignatureEqual(expected, signature);
}

function distributionQuery(leadDistributionId) {
  return {
    $or: [{ leadDistributionId }, { id: leadDistributionId }],
  };
}

function enquiryQuery(enquiryId) {
  return { $or: [{ enquiryId }, { id: enquiryId }] };
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + Number(days || 0));
  return result;
}

function presentTransaction(transaction = {}) {
  return {
    walletTransactionId:
      transaction.walletTransactionId || transaction.id || "",
    type: transaction.type || "",
    amountPaise: Number(transaction.amountPaise || 0),
    amountCredits: creditsFromPaise(transaction.amountPaise),
    currency: transaction.currency || "INR",
    balanceBeforePaise: Number(transaction.balanceBeforePaise || 0),
    balanceAfterPaise: Number(transaction.balanceAfterPaise || 0),
    balanceBeforeCredits: creditsFromPaise(transaction.balanceBeforePaise),
    balanceAfterCredits: creditsFromPaise(transaction.balanceAfterPaise),
    status: transaction.status || "posted",
    source: transaction.source || "",
    referenceId: transaction.referenceId || "",
    description: transaction.description || "",
    expiresAt: transaction.expiresAt || null,
    createdAt: transaction.createdAt || null,
  };
}

function paymentDescription(order = {}) {
  if (order.purpose === "plan_purchase") {
    return `${order.planName || "Plan"} ${order.billingCycle || ""}`.trim();
  }
  if (order.purpose === "lead_unlock") {
    return `Direct lead unlock${order.enquiryId ? ` · ${order.enquiryId}` : ""}`;
  }
  return "Legacy credit purchase";
}

function presentPaymentOrder(order = {}) {
  const totalAmountPaise = Number(order.totalAmountPaise || order.amountPaise || 0);
  return {
    paymentOrderId: order.paymentOrderId || order.id || "",
    purpose: order.purpose || "legacy_wallet_topup",
    description: paymentDescription(order),
    amountPaise: totalAmountPaise,
    listedPricePaise: Number(order.listedPricePaise || order.amountPaise || 0),
    subtotalPaise: Number(order.subtotalPaise || order.amountPaise || 0),
    gstAmountPaise: Number(order.gstAmountPaise || 0),
    totalAmountPaise,
    gstRatePercent: Number(order.gstRatePercent || 18),
    gstIncluded: order.gstIncluded === true,
    planCode: order.planCode || "",
    planName: order.planName || "",
    billingCycle: order.billingCycle || "",
    baseCredits: Number(order.baseCredits || 0),
    bonusCredits: Number(order.bonusCredits || 0),
    totalCredits: Number(
      order.totalCredits || order.creditAmount || creditsFromPaise(order.amountPaise),
    ),
    leadDistributionId: order.leadDistributionId || "",
    enquiryId: order.enquiryId || "",
    currency: order.currency || "INR",
    status: order.status || "created",
    fulfilled: order.fulfilled === true || order.walletCredited === true,
    fulfillmentStatus:
      order.fulfillmentStatus || (order.walletCredited ? "completed" : "pending"),
    createdAt: order.createdAt || null,
    paidAt: order.paidAt || null,
    fulfilledAt: order.fulfilledAt || order.creditedAt || null,
  };
}

function presentSubscription(subscription = {}) {
  return {
    providerSubscriptionId:
      subscription.providerSubscriptionId || subscription.id || "",
    planCode: subscription.planCode || "",
    planName: subscription.planName || "",
    billingCycle: subscription.billingCycle || "",
    status: subscription.status || "",
    startsAt: subscription.startsAt || null,
    expiresAt: subscription.expiresAt || null,
    purchasedAt: subscription.purchasedAt || subscription.createdAt || null,
    totalAmountPaise: Number(subscription.totalAmountPaise || 0),
    gstIncluded: subscription.gstIncluded === true,
    baseCredits: Number(subscription.baseCredits || 0),
    bonusCredits: Number(subscription.bonusCredits || 0),
    totalCredits: Number(subscription.totalCredits || 0),
  };
}

async function expireSubscriptionRecords(providerId) {
  const now = new Date();
  await ProviderSubscription.updateMany(
    { providerId, status: { $in: ["active", "scheduled"] }, expiresAt: { $lte: now } },
    { $set: { status: "expired", updatedAt: now } },
  );
  await ProviderSubscription.updateMany(
    { providerId, status: "scheduled", startsAt: { $lte: now }, expiresAt: { $gt: now } },
    { $set: { status: "active", updatedAt: now } },
  );
}

async function get(provider, filters = {}) {
  const providerId = providerIdentity(provider);
  const { page, limit, skip } = getPagination(filters);
  const syncedProvider = await creditService.syncCredits(providerId);
  await expireSubscriptionRecords(providerId);

  const [transactions, total, recentOrders, subscriptions] = await Promise.all([
    WalletTransaction.find({ providerId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    WalletTransaction.countDocuments({ providerId }),
    PaymentOrder.find({ providerId })
      .sort({ createdAt: -1 })
      .limit(12)
      .lean(),
    ProviderSubscription.find({ providerId })
      .sort({ expiresAt: -1, createdAt: -1 })
      .limit(8)
      .lean(),
  ]);

  const now = new Date();
  const currentSubscription = subscriptions.find(
    (item) => new Date(item.startsAt) <= now && new Date(item.expiresAt) > now,
  );
  const upcomingSubscription = subscriptions.find(
    (item) => new Date(item.startsAt) > now && new Date(item.expiresAt) > now,
  );

  return {
    provider: presentProvider(syncedProvider),
    plans: listPlans(),
    currentSubscription: currentSubscription
      ? presentSubscription(currentSubscription)
      : null,
    upcomingSubscription: upcomingSubscription
      ? presentSubscription(upcomingSubscription)
      : null,
    subscriptions: subscriptions.map(presentSubscription),
    razorpay: {
      enabled: Boolean(
        process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET,
      ),
    },
    paymentOrders: recentOrders.map(presentPaymentOrder),
    ...pageResult(transactions.map(presentTransaction), total, page, limit),
  };
}

async function createRazorpayOrder({ provider, paymentOrderId, receipt, amountPaise, notes }) {
  const order = await getGateway().orders.create({
    amount: amountPaise,
    currency: "INR",
    receipt,
    notes: {
      providerId: providerIdentity(provider),
      paymentOrderId,
      ...notes,
    },
  });

  if (
    !order?.id ||
    Number(order.amount) !== Number(amountPaise) ||
    String(order.currency || "").toUpperCase() !== "INR"
  ) {
    throw Object.assign(new Error("Razorpay returned an invalid order"), {
      status: 502,
      code: "RAZORPAY_ORDER_INVALID",
    });
  }
  return order;
}

function checkoutProvider(provider) {
  return {
    name: provider.name || provider.businessName || "Provider",
    email: provider.email || "",
    mobile: provider.mobile || "",
  };
}

async function createPlanOrder(provider, input = {}) {
  const providerId = providerIdentity(provider);
  const plan = getPlan(input.planCode, input.billingCycle);
  const paymentOrderId = uuid();
  const receipt = `plan_${paymentOrderId}`;
  const order = await createRazorpayOrder({
    provider,
    paymentOrderId,
    receipt,
    amountPaise: plan.totalAmountPaise,
    notes: {
      purpose: "plan_purchase",
      planCode: plan.code,
      billingCycle: plan.billingCycle,
    },
  });

  await PaymentOrder.create({
    paymentOrderId,
    providerId,
    purpose: "plan_purchase",
    razorpayOrderId: order.id,
    amountPaise: plan.totalAmountPaise,
    listedPricePaise: plan.listedPricePaise,
    subtotalPaise: plan.subtotalPaise,
    gstAmountPaise: plan.gstAmountPaise,
    totalAmountPaise: plan.totalAmountPaise,
    gstRatePercent: plan.gstRatePercent,
    gstIncluded: plan.gstIncluded,
    planCode: plan.code,
    planName: plan.name,
    billingCycle: plan.billingCycle,
    baseCredits: plan.baseCredits,
    bonusCredits: plan.bonusCredits,
    totalCredits: plan.totalCredits,
    creditAmount: plan.totalCredits,
    currency: "INR",
    status: "created",
    fulfillmentStatus: "pending",
    receipt,
  });

  return {
    keyId: process.env.RAZORPAY_KEY_ID,
    paymentOrderId,
    razorpayOrderId: order.id,
    amountPaise: plan.totalAmountPaise,
    currency: "INR",
    plan,
    provider: checkoutProvider(provider),
  };
}

async function cancelPlanOrder(provider, input = {}) {
  const providerId = providerIdentity(provider);
  const paymentOrderId = String(input.paymentOrderId || "").trim();
  if (!paymentOrderId) return { cancelled: false };
  const result = await PaymentOrder.updateOne(
    {
      paymentOrderId,
      providerId,
      purpose: "plan_purchase",
      fulfilled: { $ne: true },
      status: { $in: ["created", "failed"] },
    },
    {
      $set: {
        status: "cancelled",
        fulfillmentStatus: "cancelled",
        updatedAt: new Date(),
      },
    },
  );
  return { cancelled: result.modifiedCount > 0 };
}

async function findLeadForDirectPayment(provider, leadDistributionId) {
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
  if (lead.contactUnlocked || lead.status === "unlocked") {
    throw Object.assign(new Error("This lead is already unlocked"), {
      status: 409,
      code: "LEAD_ALREADY_UNLOCKED",
    });
  }
  if (lead.status !== "offered") {
    throw Object.assign(new Error("This lead is no longer available"), {
      status: 409,
      code: "LEAD_NOT_AVAILABLE",
    });
  }
  if (!providerCategories(provider).includes(lead.categorySlug)) {
    throw Object.assign(new Error("This lead no longer matches your categories"), {
      status: 409,
      code: "CATEGORY_MISMATCH",
    });
  }
  if (!hasCoordinates(provider, "service")) {
    throw Object.assign(new Error("Add and verify your service PIN code before unlocking leads."), {
      status: 409,
      code: "PROVIDER_LOCATION_REQUIRED",
    });
  }
  if (!isMarketplaceVisible(lead)) {
    throw Object.assign(new Error("This lead is not available in your service radius yet"), {
      status: 404,
      code: "LEAD_NOT_AVAILABLE_IN_RADIUS",
    });
  }
  return lead;
}

async function createLeadOrder(provider, leadDistributionId) {
  const providerId = providerIdentity(provider);
  const lead = await findLeadForDirectPayment(provider, leadDistributionId);
  const syncedProvider = await creditService.syncCredits(providerId);
  const enquiry = await Enquiry.findOne(enquiryQuery(lead.enquiryId || lead.requirementId)).lean();
  const baseCredits = leadCostCredits(lead);
  const pricing = {
    baseCredits,
    effectiveCredits: baseCredits,
    discountPercent: 0,
    previousUnlocks: Number(enquiry?.unlockedCount || 0),
  };
  const costMinor = paiseFromCredits(baseCredits);

  if (Number(syncedProvider.walletBalancePaise || 0) >= costMinor) {
    throw Object.assign(
      new Error("You have enough credits. Unlock this lead using credits."),
      { status: 409, code: "CREDITS_AVAILABLE" },
    );
  }

  const pendingCutoff = new Date(Date.now() - 30 * 60 * 1000);
  const existing = await PaymentOrder.findOne({
    providerId,
    purpose: "lead_unlock",
    leadDistributionId: lead.leadDistributionId || leadDistributionId,
    fulfilled: { $ne: true },
    status: { $in: ["created", "authorized", "verified"] },
    createdAt: { $gte: pendingCutoff },
  })
    .sort({ createdAt: -1 })
    .lean();

  if (existing) {
    return {
      keyId: process.env.RAZORPAY_KEY_ID,
      paymentOrderId: existing.paymentOrderId,
      razorpayOrderId: existing.razorpayOrderId,
      amountPaise: Number(existing.totalAmountPaise || existing.amountPaise),
      currency: existing.currency || "INR",
      quote: {
        subtotalPaise: Number(existing.subtotalPaise || 0),
        gstAmountPaise: Number(existing.gstAmountPaise || 0),
        totalAmountPaise: Number(existing.totalAmountPaise || existing.amountPaise),
        gstRatePercent: Number(existing.gstRatePercent || 18),
        baseCredits: Number(existing.baseLeadCostCredits || leadCostCredits(lead)),
        effectiveCredits: Number(existing.effectiveLeadCostCredits || creditsFromPaise(existing.subtotalPaise || 0)),
        discountPercent: 0,
        previousUnlocks: Number(existing.unlockCountAtPurchase || 0),
      },
      lead: {
        leadDistributionId: lead.leadDistributionId || leadDistributionId,
        enquiryId: lead.enquiryId || "",
        title: lead.leadTitle || lead.serviceType || "Lead unlock",
      },
      provider: checkoutProvider(provider),
      reused: true,
    };
  }

  const baseAmountPaise = costMinor;
  const quote = directPaymentQuote(baseAmountPaise);
  if (quote.totalAmountPaise < 100) {
    throw Object.assign(new Error("This lead does not require direct payment"), {
      status: 400,
      code: "DIRECT_PAYMENT_NOT_REQUIRED",
    });
  }

  const paymentOrderId = uuid();
  const receipt = `lead_${paymentOrderId}`;
  const order = await createRazorpayOrder({
    provider,
    paymentOrderId,
    receipt,
    amountPaise: quote.totalAmountPaise,
    notes: {
      purpose: "lead_unlock",
      leadDistributionId: lead.leadDistributionId || leadDistributionId,
      enquiryId: lead.enquiryId || "",
    },
  });

  await PaymentOrder.create({
    paymentOrderId,
    providerId,
    purpose: "lead_unlock",
    razorpayOrderId: order.id,
    amountPaise: quote.totalAmountPaise,
    listedPricePaise: quote.subtotalPaise,
    subtotalPaise: quote.subtotalPaise,
    gstAmountPaise: quote.gstAmountPaise,
    totalAmountPaise: quote.totalAmountPaise,
    gstRatePercent: quote.gstRatePercent,
    gstIncluded: false,
    leadDistributionId: lead.leadDistributionId || leadDistributionId,
    enquiryId: lead.enquiryId || "",
    currency: "INR",
    status: "created",
    fulfillmentStatus: "pending",
    baseLeadCostCredits: pricing.baseCredits,
    effectiveLeadCostCredits: pricing.effectiveCredits,
    unlockDiscountPercent: 0,
    unlockCountAtPurchase: pricing.previousUnlocks,
    receipt,
  });

  const reservation = await LeadDistribution.updateOne(
    {
      providerId,
      status: "offered",
      contactUnlocked: { $ne: true },
      $and: [
        distributionQuery(leadDistributionId),
        {
          $or: [
            { directPaymentPendingOrderId: "" },
            { directPaymentPendingOrderId: { $exists: false } },
            { directPaymentPendingUntil: { $lte: new Date() } },
          ],
        },
      ],
    },
    {
      $set: {
        directPaymentPendingOrderId: paymentOrderId,
        directPaymentPendingUntil: new Date(Date.now() + 30 * 60 * 1000),
        updatedAt: new Date(),
      },
    },
  );

  if (!reservation.modifiedCount) {
    await PaymentOrder.updateOne(
      { paymentOrderId },
      {
        $set: {
          status: "cancelled",
          fulfillmentStatus: "cancelled",
          updatedAt: new Date(),
        },
      },
    );
    throw Object.assign(
      new Error("Another unlock checkout is already active for this lead"),
      { status: 409, code: "DIRECT_PAYMENT_PENDING" },
    );
  }

  return {
    keyId: process.env.RAZORPAY_KEY_ID,
    paymentOrderId,
    razorpayOrderId: order.id,
    amountPaise: quote.totalAmountPaise,
    currency: "INR",
    quote: {
      ...quote,
      baseCredits: pricing.baseCredits,
      effectiveCredits: pricing.effectiveCredits,
      discountPercent: 0,
      previousUnlocks: pricing.previousUnlocks,
    },
    lead: {
      leadDistributionId: lead.leadDistributionId || leadDistributionId,
      enquiryId: lead.enquiryId || "",
      title: lead.leadTitle || lead.serviceType || "Lead unlock",
    },
    provider: checkoutProvider(provider),
  };
}

async function cancelLeadOrder(provider, leadDistributionId, input = {}) {
  const providerId = providerIdentity(provider);
  const paymentOrderId = String(input.paymentOrderId || "").trim();
  if (!paymentOrderId) return { cancelled: false };

  const lead = await LeadDistribution.findOne({
    providerId,
    ...distributionQuery(leadDistributionId),
  })
    .select({ leadDistributionId: 1 })
    .lean();
  const canonicalLeadId = lead?.leadDistributionId || leadDistributionId;
  const order = await PaymentOrder.findOne({
    paymentOrderId,
    providerId,
    purpose: "lead_unlock",
    leadDistributionId: canonicalLeadId,
  }).lean();
  if (!order || order.fulfilled || !["created", "failed"].includes(order.status)) {
    return { cancelled: false };
  }

  const now = new Date();
  await Promise.all([
    PaymentOrder.updateOne(
      { paymentOrderId, providerId, fulfilled: false },
      {
        $set: {
          status: "cancelled",
          fulfillmentStatus: "cancelled",
          updatedAt: now,
        },
      },
    ),
    LeadDistribution.updateOne(
      {
        providerId,
        ...distributionQuery(leadDistributionId),
        directPaymentPendingOrderId: paymentOrderId,
        contactUnlocked: { $ne: true },
      },
      {
        $set: {
          directPaymentPendingOrderId: "",
          directPaymentPendingUntil: null,
          updatedAt: now,
        },
      },
    ),
  ]);
  return { cancelled: true };
}

async function fetchPayment(paymentOrder, paymentId) {
  const payment = await getGateway().payments.fetch(paymentId);
  const orderMatches = payment.order_id === paymentOrder.razorpayOrderId;
  const amountMatches = Number(payment.amount) === Number(paymentOrder.amountPaise);
  const currencyMatches =
    String(payment.currency || "").toUpperCase() ===
    String(paymentOrder.currency || "INR").toUpperCase();

  if (!orderMatches || !amountMatches || !currencyMatches) {
    throw Object.assign(new Error("Razorpay payment details do not match"), {
      status: 400,
      code: "PAYMENT_MISMATCH",
    });
  }
  return payment;
}

async function markVerified(paymentOrder, payment) {
  await PaymentOrder.updateOne(
    { paymentOrderId: paymentOrder.paymentOrderId, fulfilled: { $ne: true } },
    {
      $set: {
        status: payment.status === "captured" ? "verified" : "authorized",
        razorpayPaymentId: payment.id,
        signatureVerified: true,
        paidAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );
}

async function fulfillPlanOrder(paymentOrder, paymentId) {
  return withTransaction(async (session) => {
    const order = await PaymentOrder.findOne({
      paymentOrderId: paymentOrder.paymentOrderId,
    }).session(session);

    if (!order) {
      throw Object.assign(new Error("Plan payment order not found"), {
        status: 404,
        code: "PAYMENT_ORDER_NOT_FOUND",
      });
    }
    if (order.fulfilled) {
      const provider = await Provider.findOne(providerQuery(order.providerId))
        .session(session)
        .lean();
      return {
        status: "completed",
        purpose: "plan_purchase",
        provider: presentProvider(provider),
        paymentOrder: presentPaymentOrder(order.toObject()),
        duplicate: true,
      };
    }

    const plan = getPlan(order.planCode, order.billingCycle);
    const now = new Date();
    const latest = await ProviderSubscription.findOne({
      providerId: order.providerId,
      expiresAt: { $gt: now },
      status: { $in: ["active", "scheduled"] },
    })
      .sort({ expiresAt: -1 })
      .session(session);
    const startsAt = latest?.expiresAt && new Date(latest.expiresAt) > now
      ? new Date(latest.expiresAt)
      : now;
    const expiresAt = addDays(startsAt, plan.durationDays);
    const providerSubscriptionId = uuid();
    const [subscription] = await ProviderSubscription.create(
      [
        {
          providerSubscriptionId,
          providerId: order.providerId,
          paymentOrderId: order.paymentOrderId,
          planCode: plan.code,
          planName: plan.name,
          billingCycle: plan.billingCycle,
          status: startsAt > now ? "scheduled" : "active",
          startsAt,
          expiresAt,
          purchasedAt: now,
          listedPricePaise: plan.listedPricePaise,
          subtotalPaise: plan.subtotalPaise,
          gstAmountPaise: plan.gstAmountPaise,
          totalAmountPaise: plan.totalAmountPaise,
          gstIncluded: plan.gstIncluded,
          baseCredits: plan.baseCredits,
          bonusCredits: plan.bonusCredits,
          totalCredits: plan.totalCredits,
        },
      ],
      { session },
    );

    await creditService.extendActivePlanAllocations(
      order.providerId,
      expiresAt,
      session,
    );
    const creditResult = await creditService.addCredits(
      order.providerId,
      {
        source: "plan_purchase",
        referenceId: order.paymentOrderId,
        paymentOrderId: order.paymentOrderId,
        providerSubscriptionId,
        planCode: plan.code,
        billingCycle: plan.billingCycle,
        amountMinorCredits: paiseFromCredits(plan.totalCredits),
        expiresAt,
        metadata: {
          baseCredits: plan.baseCredits,
          bonusCredits: plan.bonusCredits,
          bonusPercent: plan.bonusPercent,
        },
      },
      session,
    );

    const walletTransactionId = uuid();
    await WalletTransaction.create(
      [
        {
          walletTransactionId,
          providerId: order.providerId,
          type: "credit",
          amountPaise: paiseFromCredits(plan.totalCredits),
          currency: "INR",
          balanceBeforePaise: creditResult.balanceBeforePaise,
          balanceAfterPaise: creditResult.balanceAfterPaise,
          status: "posted",
          source: "plan_purchase",
          referenceId: order.paymentOrderId,
          idempotencyKey: `plan-credit:${order.paymentOrderId}`,
          description: `${plan.name} ${plan.billingCycle} plan · ${plan.totalCredits} credits`,
          expiresAt,
          metadata: {
            providerSubscriptionId,
            planCode: plan.code,
            billingCycle: plan.billingCycle,
            baseCredits: plan.baseCredits,
            bonusCredits: plan.bonusCredits,
          },
        },
      ],
      { session },
    );

    const updatedProvider = await Provider.findOneAndUpdate(
      providerQuery(order.providerId),
      {
        $set: {
          currentPlanCode: plan.code,
          currentPlanName: plan.name,
          currentBillingCycle: plan.billingCycle,
          currentPlanStartedAt: startsAt,
          currentPlanExpiresAt: expiresAt,
          currentSubscriptionId: providerSubscriptionId,
          walletUpdatedAt: now,
          updatedAt: now,
        },
      },
      { new: true, session },
    );

    await PaymentOrder.updateOne(
      { paymentOrderId: order.paymentOrderId, fulfilled: false },
      {
        $set: {
          status: "paid",
          razorpayPaymentId: paymentId,
          signatureVerified: true,
          fulfilled: true,
          fulfillmentStatus: "completed",
          fulfillmentReferenceId: providerSubscriptionId,
          walletCredited: true,
          walletTransactionId,
          paidAt: order.paidAt || now,
          fulfilledAt: now,
          creditedAt: now,
          updatedAt: now,
        },
      },
      { session },
    );

    return {
      status: "completed",
      purpose: "plan_purchase",
      provider: presentProvider(updatedProvider),
      subscription: presentSubscription(subscription.toObject()),
      paymentOrder: presentPaymentOrder({
        ...order.toObject(),
        status: "paid",
        fulfilled: true,
        fulfillmentStatus: "completed",
        fulfilledAt: now,
      }),
    };
  });
}

async function fulfillLeadOrder(paymentOrder, paymentId) {
  return withTransaction(async (session) => {
    const order = await PaymentOrder.findOne({
      paymentOrderId: paymentOrder.paymentOrderId,
    }).session(session);

    if (!order) {
      throw Object.assign(new Error("Lead payment order not found"), {
        status: 404,
        code: "PAYMENT_ORDER_NOT_FOUND",
      });
    }

    const existingLead = await LeadDistribution.findOne({
      providerId: order.providerId,
      ...distributionQuery(order.leadDistributionId),
    }).session(session);

    if (!existingLead) {
      throw Object.assign(new Error("Lead offer not found"), {
        status: 404,
        code: "LEAD_NOT_FOUND",
      });
    }

    if (order.fulfilled) {
      return {
        status: "completed",
        purpose: "lead_unlock",
        lead: presentLead(existingLead.toObject()),
        paymentOrder: presentPaymentOrder(order.toObject()),
        duplicate: true,
      };
    }

    if (existingLead.contactUnlocked || existingLead.status === "unlocked") {
      await PaymentOrder.updateOne(
        { paymentOrderId: order.paymentOrderId },
        {
          $set: {
            status: "paid",
            fulfilled: true,
            fulfillmentStatus: "already_unlocked",
            fulfillmentReferenceId:
              existingLead.leadDistributionId || order.leadDistributionId,
            razorpayPaymentId: paymentId,
            paidAt: order.paidAt || new Date(),
            fulfilledAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { session },
      );
      return {
        status: "completed",
        purpose: "lead_unlock",
        lead: presentLead(existingLead.toObject()),
        paymentOrder: presentPaymentOrder({
          ...order.toObject(),
          status: "paid",
          fulfilled: true,
          fulfillmentStatus: "already_unlocked",
        }),
        duplicate: true,
      };
    }

    if (existingLead.status !== "offered") {
      throw Object.assign(new Error("This paid lead requires manual review"), {
        status: 409,
        code: "PAID_LEAD_REVIEW_REQUIRED",
      });
    }

    const provider = await Provider.findOne({
      ...providerQuery(order.providerId),
      status: "active",
      portalAccessEnabled: { $ne: false },
    }).session(session);
    if (!provider) {
      throw Object.assign(new Error("Provider account is not eligible"), {
        status: 403,
        code: "PROVIDER_INELIGIBLE",
      });
    }

    const now = new Date();
    const unlocked = await LeadDistribution.findOneAndUpdate(
      {
        providerId: order.providerId,
        ...distributionQuery(order.leadDistributionId),
        status: "offered",
        contactUnlocked: { $ne: true },
      },
      {
        $set: {
          contactUnlocked: true,
          status: "unlocked",
          unlockedAt: now,
          unlockMethod: "direct_payment",
          paymentOrderId: order.paymentOrderId,
          directPaymentAmountPaise: Number(order.subtotalPaise || 0),
          directPaymentGstPaise: Number(order.gstAmountPaise || 0),
          directPaymentTotalPaise: Number(order.totalAmountPaise || order.amountPaise || 0),
          directPaymentPendingOrderId: "",
          directPaymentPendingUntil: null,
          baseLeadCostCredits: Number(order.baseLeadCostCredits ?? leadCostCredits(existingLead)),
          effectiveLeadCostCredits: Number(order.effectiveLeadCostCredits ?? creditsFromPaise(order.subtotalPaise || 0)),
          unlockDiscountPercent: 0,
          unlockCountAtPurchase: Number(order.unlockCountAtPurchase || 0),
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
      enquiryQuery(existingLead.enquiryId || existingLead.requirementId),
      { $inc: { unlockedCount: 1 }, $set: { updatedAt: now } },
      { session },
    );

    await PaymentOrder.updateOne(
      { paymentOrderId: order.paymentOrderId, fulfilled: false },
      {
        $set: {
          status: "paid",
          razorpayPaymentId: paymentId,
          signatureVerified: true,
          fulfilled: true,
          fulfillmentStatus: "completed",
          fulfillmentReferenceId:
            unlocked.leadDistributionId || order.leadDistributionId,
          paidAt: order.paidAt || now,
          fulfilledAt: now,
          updatedAt: now,
        },
      },
      { session },
    );

    return {
      status: "completed",
      purpose: "lead_unlock",
      lead: presentLead(unlocked.toObject()),
      provider: presentProvider(provider),
      paymentOrder: presentPaymentOrder({
        ...order.toObject(),
        status: "paid",
        fulfilled: true,
        fulfillmentStatus: "completed",
        fulfilledAt: now,
      }),
    };
  });
}

async function fulfillPaymentOrder(paymentOrder, paymentId) {
  if (paymentOrder.fulfilled || paymentOrder.walletCredited) {
    if (paymentOrder.purpose === "lead_unlock") {
      const lead = await LeadDistribution.findOne({
        providerId: paymentOrder.providerId,
        ...distributionQuery(paymentOrder.leadDistributionId),
      }).lean();
      return {
        status: "completed",
        purpose: "lead_unlock",
        lead: lead ? presentLead(lead) : null,
        paymentOrder: presentPaymentOrder(paymentOrder),
        duplicate: true,
      };
    }
    const provider = await Provider.findOne(
      providerQuery(paymentOrder.providerId),
    ).lean();
    return {
      status: "completed",
      purpose: paymentOrder.purpose,
      provider: presentProvider(provider),
      paymentOrder: presentPaymentOrder(paymentOrder),
      duplicate: true,
    };
  }

  try {
    if (paymentOrder.purpose === "plan_purchase") {
      return await fulfillPlanOrder(paymentOrder, paymentId);
    }
    if (paymentOrder.purpose === "lead_unlock") {
      return await fulfillLeadOrder(paymentOrder, paymentId);
    }
    throw Object.assign(
      new Error("Legacy wallet top-ups are no longer available"),
      { status: 409, code: "LEGACY_TOPUP_DISABLED" },
    );
  } catch (error) {
    if ([
      "PAID_LEAD_REVIEW_REQUIRED",
      "PROVIDER_INELIGIBLE",
      "LEAD_NOT_FOUND",
    ].includes(error?.code)) {
      await PaymentOrder.updateOne(
        { paymentOrderId: paymentOrder.paymentOrderId, fulfilled: false },
        {
          $set: {
            status: "paid_pending_review",
            fulfillmentStatus: "manual_review",
            fulfillmentError: error.message,
            razorpayPaymentId: paymentId,
            paidAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );
    }
    throw error;
  }
}

async function verify(provider, input = {}, expected = {}) {
  const providerId = providerIdentity(provider);
  const razorpayOrderId = String(input.razorpay_order_id || "").trim();
  const razorpayPaymentId = String(input.razorpay_payment_id || "").trim();
  const razorpaySignature = String(input.razorpay_signature || "").trim();

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw Object.assign(new Error("Incomplete Razorpay payment response"), {
      status: 400,
      code: "PAYMENT_RESPONSE_INCOMPLETE",
    });
  }

  const paymentOrder = await PaymentOrder.findOne({
    providerId,
    razorpayOrderId,
  }).lean();

  if (!paymentOrder) {
    throw Object.assign(new Error("Payment order not found"), {
      status: 404,
      code: "PAYMENT_ORDER_NOT_FOUND",
    });
  }
  if (expected.purpose && paymentOrder.purpose !== expected.purpose) {
    throw Object.assign(new Error("Payment purpose does not match"), {
      status: 400,
      code: "PAYMENT_PURPOSE_MISMATCH",
    });
  }
  if (
    expected.leadDistributionId &&
    paymentOrder.leadDistributionId !== expected.leadDistributionId
  ) {
    throw Object.assign(new Error("Payment does not match this lead"), {
      status: 400,
      code: "PAYMENT_LEAD_MISMATCH",
    });
  }

  if (
    !verifyCheckoutSignature(
      paymentOrder.razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    )
  ) {
    throw Object.assign(new Error("Invalid Razorpay payment signature"), {
      status: 400,
      code: "PAYMENT_SIGNATURE_INVALID",
    });
  }

  const payment = await fetchPayment(paymentOrder, razorpayPaymentId);
  if (!["authorized", "captured"].includes(payment.status)) {
    await PaymentOrder.updateOne(
      { paymentOrderId: paymentOrder.paymentOrderId },
      {
        $set: {
          status: "failed",
          razorpayPaymentId,
          updatedAt: new Date(),
        },
      },
    );
    throw Object.assign(
      new Error(`Razorpay payment is ${payment.status || "not successful"}`),
      { status: 400, code: "PAYMENT_NOT_SUCCESSFUL" },
    );
  }

  await markVerified(paymentOrder, payment);
  if (payment.status === "authorized") {
    return {
      status: "pending",
      purpose: paymentOrder.purpose,
      message: "Payment is authorised and will complete after capture",
      paymentOrder: presentPaymentOrder({
        ...paymentOrder,
        status: "authorized",
      }),
    };
  }

  return fulfillPaymentOrder(
    { ...paymentOrder, status: "verified", signatureVerified: true },
    razorpayPaymentId,
  );
}

async function verifyLead(provider, leadDistributionId, input = {}) {
  const providerId = providerIdentity(provider);
  const lead = await LeadDistribution.findOne({
    providerId,
    ...distributionQuery(leadDistributionId),
  })
    .select({ leadDistributionId: 1 })
    .lean();
  const canonicalLeadId = lead?.leadDistributionId || leadDistributionId;
  return verify(provider, input, {
    purpose: "lead_unlock",
    leadDistributionId: canonicalLeadId,
  });
}

async function webhook(rawBody, signature) {
  if (!Buffer.isBuffer(rawBody)) {
    throw Object.assign(new Error("Webhook body must be raw bytes"), {
      status: 400,
      code: "WEBHOOK_BODY_INVALID",
    });
  }
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    throw Object.assign(new Error("Razorpay webhook secret is not configured"), {
      status: 503,
      code: "WEBHOOK_NOT_CONFIGURED",
    });
  }

  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  if (!safeSignatureEqual(expected, signature)) {
    throw Object.assign(new Error("Invalid Razorpay webhook signature"), {
      status: 400,
      code: "WEBHOOK_SIGNATURE_INVALID",
    });
  }

  const event = JSON.parse(rawBody.toString("utf8"));
  if (!["payment.captured", "order.paid"].includes(event.event)) {
    return { ignored: true };
  }

  let payment = event.payload?.payment?.entity || null;
  const razorpayOrderId =
    payment?.order_id || event.payload?.order?.entity?.id || "";
  if (!razorpayOrderId) return { ignored: true };

  const paymentOrder = await PaymentOrder.findOne({ razorpayOrderId }).lean();
  if (!paymentOrder) return { ignored: true };
  if (paymentOrder.fulfilled || paymentOrder.walletCredited) {
    return {
      completed: true,
      paymentOrderId: paymentOrder.paymentOrderId,
      duplicate: true,
    };
  }

  if (!payment) {
    const payments = await getGateway().orders.fetchPayments(razorpayOrderId);
    payment = payments.items?.find((item) => item.status === "captured") || null;
  }
  if (!payment) return { ignored: true, pending: true };

  const verifiedPayment = await fetchPayment(paymentOrder, payment.id);
  if (verifiedPayment.status !== "captured") {
    return { ignored: true, pending: true };
  }

  await markVerified(paymentOrder, verifiedPayment);
  const result = await fulfillPaymentOrder(paymentOrder, payment.id);
  return {
    completed: result.status === "completed",
    purpose: result.purpose,
    paymentOrderId: paymentOrder.paymentOrderId,
  };
}

module.exports = {
  cancelLeadOrder,
  cancelPlanOrder,
  createLeadOrder,
  createPlanOrder,
  get,
  verify,
  verifyLead,
  webhook,
};
