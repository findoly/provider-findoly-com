"use strict";

const PaymentOrder = require("../../models/PaymentOrder");
const ProviderSubscription = require("../../models/ProviderSubscription");
const outboxService = require("./provider-communication-outbox-service");

async function enqueueForCompletedPayment(paymentOrderIdInput) {
  const paymentOrderId = String(paymentOrderIdInput || "").trim();
  if (!paymentOrderId) return { queued: false, reason: "payment_order_missing" };

  const order = await PaymentOrder.findOne({ paymentOrderId }).lean();
  if (!order || order.purpose !== "plan_purchase") {
    return { queued: false, reason: "not_plan_purchase" };
  }
  if (order.fulfilled !== true && order.walletCredited !== true) {
    return { queued: false, reason: "plan_not_fulfilled" };
  }

  const subscription = await ProviderSubscription.findOne({
    paymentOrderId,
    providerId: order.providerId,
  }).lean();
  if (!subscription) {
    throw Object.assign(new Error("Completed plan purchase subscription was not found for email confirmation"), {
      code: "PLAN_EMAIL_SUBSCRIPTION_NOT_FOUND",
    });
  }

  const event = await outboxService.enqueuePlanPurchase({
    providerId: order.providerId,
    paymentOrderId,
    providerSubscriptionId: subscription.providerSubscriptionId,
    planCode: subscription.planCode || order.planCode,
    planName: subscription.planName || order.planName,
    billingCycle: subscription.billingCycle || order.billingCycle,
    totalCredits: Number(subscription.totalCredits || order.totalCredits || order.creditAmount || 0),
    totalAmountPaise: Number(subscription.totalAmountPaise || order.totalAmountPaise || order.amountPaise || 0),
    planStatus: subscription.status || "active",
    startsAt: subscription.startsAt || null,
    expiresAt: subscription.expiresAt || null,
    purchasedAt: subscription.purchasedAt || order.fulfilledAt || order.paidAt || new Date(),
  });

  return { queued: true, eventId: event.eventId };
}

module.exports = { enqueueForCompletedPayment };
