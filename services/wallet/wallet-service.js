const crypto = require("crypto");
const Razorpay = require("razorpay");
const Provider = require("../../models/Provider");
const WalletTransaction = require("../../models/WalletTransaction");
const PaymentOrder = require("../../models/PaymentOrder");
const uuid = require("../../utils/uuid");
const { getPagination, pageResult } = require("../../utils/pagination");
const {
  providerIdentity,
  providerQuery,
  presentProvider,
} = require("../../utils/provider");
const { withTransaction } = require("../../utils/transaction");

function getGateway() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw Object.assign(new Error("Razorpay wallet top-up is not configured"), {
      status: 503,
      code: "RAZORPAY_NOT_CONFIGURED",
    });
  }

  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

function validateAmount(amountPaise) {
  const amount = Math.round(Number(amountPaise || 0));
  const minimum = Number(process.env.WALLET_MIN_TOPUP_PAISE || 10000);
  const maximum = Number(process.env.WALLET_MAX_TOPUP_PAISE || 10000000);

  if (!Number.isSafeInteger(amount) || amount < minimum || amount > maximum) {
    throw Object.assign(
      new Error(
        `Wallet top-up must be between ₹${minimum / 100} and ₹${maximum / 100}`,
      ),
      { status: 400, code: "TOPUP_AMOUNT_INVALID" },
    );
  }

  return amount;
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

function presentTransaction(transaction = {}) {
  return {
    walletTransactionId:
      transaction.walletTransactionId || transaction.id || "",
    type: transaction.type || "",
    amountPaise: Number(transaction.amountPaise || 0),
    currency: transaction.currency || "INR",
    balanceBeforePaise: Number(transaction.balanceBeforePaise || 0),
    balanceAfterPaise: Number(transaction.balanceAfterPaise || 0),
    status: transaction.status || "posted",
    source: transaction.source || "",
    referenceId: transaction.referenceId || "",
    description: transaction.description || "",
    createdAt: transaction.createdAt || null,
  };
}

function presentPaymentOrder(order = {}) {
  return {
    paymentOrderId: order.paymentOrderId || order.id || "",
    amountPaise: Number(order.amountPaise || 0),
    currency: order.currency || "INR",
    status: order.status || "created",
    walletCredited: order.walletCredited === true,
    createdAt: order.createdAt || null,
    paidAt: order.paidAt || null,
    creditedAt: order.creditedAt || null,
  };
}

async function get(provider, filters = {}) {
  const providerId = providerIdentity(provider);
  const { page, limit, skip } = getPagination(filters);

  const [transactions, total, recentOrders] = await Promise.all([
    WalletTransaction.find({ providerId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    WalletTransaction.countDocuments({ providerId }),
    PaymentOrder.find({ providerId })
      .sort({ createdAt: -1 })
      .limit(8)
      .lean(),
  ]);

  return {
    provider: presentProvider(provider),
    razorpay: {
      enabled: Boolean(
        process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET,
      ),
      keyId: process.env.RAZORPAY_KEY_ID || "",
      minimumPaise: Number(process.env.WALLET_MIN_TOPUP_PAISE || 10000),
      maximumPaise: Number(process.env.WALLET_MAX_TOPUP_PAISE || 10000000),
    },
    paymentOrders: recentOrders.map(presentPaymentOrder),
    ...pageResult(transactions.map(presentTransaction), total, page, limit),
  };
}

async function createOrder(provider, amountInput) {
  const providerId = providerIdentity(provider);
  const amountPaise = validateAmount(amountInput);
  const gateway = getGateway();
  const paymentOrderId = uuid();
  const receipt = `wal_${paymentOrderId}`;

  const order = await gateway.orders.create({
    amount: amountPaise,
    currency: "INR",
    receipt,
    notes: {
      providerId,
      paymentOrderId,
      purpose: "provider_wallet_topup",
    },
  });

  if (
    !order?.id ||
    Number(order.amount) !== amountPaise ||
    String(order.currency || "").toUpperCase() !== "INR"
  ) {
    throw Object.assign(new Error("Razorpay returned an invalid order"), {
      status: 502,
      code: "RAZORPAY_ORDER_INVALID",
    });
  }

  await PaymentOrder.create({
    paymentOrderId,
    providerId,
    razorpayOrderId: order.id,
    amountPaise,
    currency: "INR",
    status: "created",
    receipt,
  });

  return {
    keyId: process.env.RAZORPAY_KEY_ID,
    paymentOrderId,
    razorpayOrderId: order.id,
    amountPaise,
    currency: "INR",
    provider: {
      name: provider.name || provider.businessName || "Provider",
      email: provider.email || "",
      mobile: provider.mobile || "",
    },
  };
}

async function fetchPayment(paymentOrder, paymentId) {
  const payment = await getGateway().payments.fetch(paymentId);
  const orderMatches = payment.order_id === paymentOrder.razorpayOrderId;
  const amountMatches =
    Number(payment.amount) === Number(paymentOrder.amountPaise);
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
    {
      paymentOrderId: paymentOrder.paymentOrderId,
      walletCredited: { $ne: true },
    },
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

async function creditOrder(paymentOrder, paymentId) {
  const idempotencyKey = `razorpay:${paymentOrder.razorpayOrderId}`;
  const existing = await WalletTransaction.findOne({ idempotencyKey }).lean();
  if (existing) return existing;

  try {
    return await withTransaction(async (session) => {
      const order = await PaymentOrder.findOne({
        paymentOrderId: paymentOrder.paymentOrderId,
      }).session(session);

      if (!order) {
        throw Object.assign(new Error("Wallet payment order not found"), {
          status: 404,
          code: "PAYMENT_ORDER_NOT_FOUND",
        });
      }

      if (order.walletCredited) {
        const transaction = await WalletTransaction.findOne({ idempotencyKey })
          .session(session)
          .lean();
        if (transaction) return transaction;
        throw Object.assign(new Error("Wallet order is in an invalid state"), {
          status: 409,
          code: "PAYMENT_ORDER_INCONSISTENT",
        });
      }

      const currentProvider = await Provider.findOneAndUpdate(
        {
          ...providerQuery(order.providerId),
          status: "active",
          portalAccessEnabled: { $ne: false },
        },
        {
          $inc: { walletBalancePaise: order.amountPaise },
          $set: { walletUpdatedAt: new Date(), updatedAt: new Date() },
        },
        { new: true, session },
      );

      if (!currentProvider) {
        throw Object.assign(new Error("Provider account is not eligible"), {
          status: 403,
          code: "PROVIDER_INELIGIBLE",
        });
      }

      const walletTransactionId = uuid();
      const balanceAfterPaise = Number(currentProvider.walletBalancePaise || 0);
      const [transaction] = await WalletTransaction.create(
        [
          {
            walletTransactionId,
            providerId: order.providerId,
            type: "credit",
            amountPaise: order.amountPaise,
            currency: order.currency,
            balanceBeforePaise: balanceAfterPaise - order.amountPaise,
            balanceAfterPaise,
            status: "posted",
            source: "razorpay",
            referenceId: order.razorpayOrderId,
            idempotencyKey,
            description: `Razorpay wallet top-up ₹${order.amountPaise / 100}`,
            metadata: { razorpayPaymentId: paymentId },
          },
        ],
        { session },
      );

      await PaymentOrder.updateOne(
        {
          paymentOrderId: order.paymentOrderId,
          walletCredited: false,
        },
        {
          $set: {
            status: "paid",
            razorpayPaymentId: paymentId,
            signatureVerified: true,
            walletCredited: true,
            walletTransactionId,
            paidAt: order.paidAt || new Date(),
            creditedAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { session },
      );

      return transaction.toObject();
    });
  } catch (error) {
    if (error?.code === 11000) {
      const transaction = await WalletTransaction.findOne({
        idempotencyKey,
      }).lean();
      if (transaction) return transaction;
    }
    throw error;
  }
}

async function verify(provider, input = {}) {
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
    throw Object.assign(new Error("Wallet payment order not found"), {
      status: 404,
      code: "PAYMENT_ORDER_NOT_FOUND",
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
      message: "Payment is authorised and will be credited after capture",
      provider: presentProvider(provider),
    };
  }

  const transaction = await creditOrder(paymentOrder, razorpayPaymentId);
  const updatedProvider = await Provider.findOne(providerQuery(providerId)).lean();

  return {
    status: "credited",
    transaction,
    provider: presentProvider(updatedProvider),
  };
}

async function webhook(rawBody, signature) {
  if (!Buffer.isBuffer(rawBody)) {
    throw Object.assign(new Error("Webhook body must be raw bytes"), {
      status: 400,
      code: "WEBHOOK_BODY_INVALID",
    });
  }

  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    throw Object.assign(
      new Error("Razorpay webhook secret is not configured"),
      { status: 503, code: "WEBHOOK_NOT_CONFIGURED" },
    );
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
  if (![
    "payment.captured",
    "order.paid",
  ].includes(event.event)) {
    return { ignored: true };
  }

  let payment = event.payload?.payment?.entity || null;
  const razorpayOrderId =
    payment?.order_id || event.payload?.order?.entity?.id || "";
  if (!razorpayOrderId) return { ignored: true };

  const paymentOrder = await PaymentOrder.findOne({ razorpayOrderId }).lean();
  if (!paymentOrder) return { ignored: true };
  if (paymentOrder.walletCredited) {
    return {
      credited: true,
      walletTransactionId: paymentOrder.walletTransactionId || "",
      duplicate: true,
    };
  }

  if (!payment) {
    const payments = await getGateway().orders.fetchPayments(razorpayOrderId);
    payment =
      payments.items?.find((item) => item.status === "captured") || null;
  }

  if (!payment) return { ignored: true, pending: true };
  const verifiedPayment = await fetchPayment(paymentOrder, payment.id);
  if (verifiedPayment.status !== "captured") {
    return { ignored: true, pending: true };
  }

  const transaction = await creditOrder(paymentOrder, payment.id);
  return {
    credited: true,
    walletTransactionId: transaction.walletTransactionId,
  };
}

module.exports = { get, createOrder, verify, webhook };
