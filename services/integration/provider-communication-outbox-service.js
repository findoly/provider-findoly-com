"use strict";

const ProviderCommunicationEventOutbox = require("../../models/ProviderCommunicationEventOutbox");
const uuid = require("../../utils/uuid");
const crmService = require("./crm-service");

const EVENT_NAME = "provider_join_request_submitted";
const PLAN_EVENT_NAME = "provider_plan_purchased";
const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 100;
const LOCK_LEASE_MS = 2 * 60 * 1000;
const BASE_RETRY_MS = 30 * 1000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;

function maximumAttempts(env = process.env) {
  const value = Number(env.PROVIDER_COMMUNICATION_MAX_ATTEMPTS || 20);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 20;
}

function retentionDays(env = process.env) {
  const value = Number(env.PROVIDER_COMMUNICATION_EVENT_RETENTION_DAYS || 30);
  return Number.isInteger(value) && value >= 1 && value <= 365 ? value : 30;
}

function retryDelayMs(attemptNumber) {
  const exponent = Math.max(0, Math.min(10, Number(attemptNumber || 1) - 1));
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** exponent));
}

function eventIdFor(providerJoinRequestId) {
  return `provider-join-request-submitted:${String(providerJoinRequestId || "").trim()}`;
}

function eventPayload(request = {}, eventId = eventIdFor(request.providerJoinRequestId)) {
  return {
    integrationEventId: eventId,
    idempotencySuffix: eventId,
    providerJoinRequestId: request.providerJoinRequestId,
    eventAt: request.createdAt || new Date(),
  };
}

function planEventIdFor(paymentOrderId) {
  return `provider-plan-purchased:${String(paymentOrderId || "").trim()}`;
}

function planEventPayload(purchase = {}, eventId = planEventIdFor(purchase.paymentOrderId)) {
  return {
    integrationEventId: eventId,
    idempotencySuffix: eventId,
    providerId: String(purchase.providerId || "").trim(),
    paymentOrderId: String(purchase.paymentOrderId || "").trim(),
    providerSubscriptionId: String(purchase.providerSubscriptionId || "").trim(),
    planCode: String(purchase.planCode || "").trim(),
    planName: String(purchase.planName || "").trim(),
    billingCycle: String(purchase.billingCycle || "").trim(),
    totalCredits: Number(purchase.totalCredits || 0),
    totalAmountPaise: Number(purchase.totalAmountPaise || 0),
    planStatus: String(purchase.planStatus || purchase.status || "").trim(),
    startsAt: purchase.startsAt || null,
    expiresAt: purchase.expiresAt || null,
    eventAt: purchase.purchasedAt || purchase.createdAt || new Date(),
  };
}

async function enqueue(request = {}, options = {}) {
  const providerJoinRequestId = String(request.providerJoinRequestId || "").trim();
  if (!providerJoinRequestId) throw new Error("Provider joining request ID is required for the internal alert event");
  const eventId = eventIdFor(providerJoinRequestId);
  const now = options.now || new Date();
  const rows = await ProviderCommunicationEventOutbox.create([
    {
      eventId,
      idempotencyKey: eventId,
      eventName: EVENT_NAME,
      providerJoinRequestId,
      payload: eventPayload(request, eventId),
      status: "pending",
      attemptCount: 0,
      lastError: "",
      nextAttemptAt: now,
    },
  ], { session: options.session });
  console.info({ event: "provider_join_request_event_queued", integrationEventId: eventId, providerJoinRequestId });
  return rows[0];
}

async function enqueuePlanPurchase(purchase = {}, options = {}) {
  const providerId = String(purchase.providerId || "").trim();
  const paymentOrderId = String(purchase.paymentOrderId || "").trim();
  const providerSubscriptionId = String(purchase.providerSubscriptionId || "").trim();
  if (!providerId || !paymentOrderId || !providerSubscriptionId) {
    throw new Error("Provider, payment order and subscription IDs are required for the plan purchase email event");
  }
  const eventId = planEventIdFor(paymentOrderId);
  const now = options.now || new Date();
  const syntheticRequestId = `plan:${paymentOrderId}`;
  const row = await ProviderCommunicationEventOutbox.findOneAndUpdate(
    { eventId },
    {
      $setOnInsert: {
        eventId,
        idempotencyKey: eventId,
        eventName: PLAN_EVENT_NAME,
        providerJoinRequestId: syntheticRequestId,
        providerId,
        paymentOrderId,
        providerSubscriptionId,
        payload: planEventPayload(purchase, eventId),
        status: "pending",
        attemptCount: 0,
        lastError: "",
        nextAttemptAt: now,
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
      ...(options.session ? { session: options.session } : {}),
    },
  );
  console.info({ event: "provider_plan_purchase_event_queued", integrationEventId: eventId, providerId, paymentOrderId });
  return row;
}

function claimFilter({ eventId = "", force = false, now = new Date(), statuses = ["pending", "failed"] } = {}) {
  const query = {
    status: { $in: statuses },
    $or: [
      { lockedAt: null },
      { lockedAt: { $lt: new Date(now.getTime() - LOCK_LEASE_MS) } },
    ],
  };
  if (eventId) query.eventId = eventId;
  if (!force) query.nextAttemptAt = { $lte: now };
  return query;
}

async function claimOne(options = {}) {
  const now = options.now || new Date();
  const lockToken = uuid();
  return ProviderCommunicationEventOutbox.findOneAndUpdate(
    claimFilter({ ...options, now }),
    {
      $set: { lockedAt: now, lockToken, lastAttemptAt: now },
      $inc: { attemptCount: 1 },
    },
    { new: true, sort: { nextAttemptAt: 1, _id: 1 } },
  ).lean();
}

async function complete(event, now = new Date()) {
  return ProviderCommunicationEventOutbox.updateOne(
    { eventId: event.eventId, lockToken: event.lockToken },
    {
      $set: {
        status: "synced",
        lastError: "",
        syncedAt: now,
        nextAttemptAt: null,
        lockedAt: null,
        lockToken: "",
        purgeAfterAt: new Date(now.getTime() + retentionDays() * 24 * 60 * 60 * 1000),
      },
    },
  );
}

async function fail(event, error, now = new Date()) {
  const attempts = Number(event.attemptCount || 1);
  const permanent = error?.retryable === false;
  const deadLetter = permanent || attempts >= maximumAttempts();
  return ProviderCommunicationEventOutbox.updateOne(
    { eventId: event.eventId, lockToken: event.lockToken },
    {
      $set: {
        status: deadLetter ? "dead_letter" : "failed",
        lastError: String(error?.message || error || "CRM communication failed").slice(0, 1000),
        nextAttemptAt: deadLetter ? null : new Date(now.getTime() + retryDelayMs(attempts)),
        lockedAt: null,
        lockToken: "",
        purgeAfterAt: deadLetter
          ? new Date(now.getTime() + retentionDays() * 24 * 60 * 60 * 1000)
          : null,
      },
    },
  );
}

async function processClaimed(event) {
  if (!event) return { processed: false, synced: false, reason: "not_due" };
  const startedAt = Date.now();
  console.info({
    event: "provider_communication_event_dispatch_started",
    eventName: event.eventName,
    integrationEventId: event.eventId,
    providerJoinRequestId: event.providerJoinRequestId,
    providerId: event.providerId || "",
    paymentOrderId: event.paymentOrderId || "",
    attemptCount: event.attemptCount,
  });
  try {
    const result = await crmService.sendEvent(event.eventName, event.payload || {});
    if (result.skipped) {
      throw Object.assign(new Error(result.reason || "CRM communication integration is not configured"), {
        code: "CRM_COMMUNICATION_NOT_CONFIGURED",
      });
    }
    if (result.deliveryFailed) {
      throw Object.assign(new Error(result.deliveryWarning || "CRM communication delivery failed"), {
        code: "CRM_COMMUNICATION_DELIVERY_FAILED",
      });
    }
    const update = await complete(event);
    if (!update.modifiedCount) return { processed: false, synced: false, reason: "lease_lost", eventId: event.eventId };
    console.info({
      event: "provider_communication_event_dispatch_completed",
      eventName: event.eventName,
      integrationEventId: event.eventId,
      providerId: event.providerId || "",
      paymentOrderId: event.paymentOrderId || "",
      attemptCount: event.attemptCount,
      durationMs: Number((Date.now() - startedAt).toFixed(2)),
    });
    return { processed: true, synced: true, eventId: event.eventId };
  } catch (error) {
    const update = await fail(event, error);
    console.error({
      event: "provider_communication_event_dispatch_failed",
      eventName: event.eventName,
      integrationEventId: event.eventId,
      providerId: event.providerId || "",
      paymentOrderId: event.paymentOrderId || "",
      attemptCount: event.attemptCount,
      retryable: error?.retryable !== false,
      code: String(error?.code || "CRM_COMMUNICATION_FAILED"),
      message: String(error?.message || error).slice(0, 1000),
      durationMs: Number((Date.now() - startedAt).toFixed(2)),
    });
    return { processed: Boolean(update.modifiedCount), synced: false, eventId: event.eventId, error: String(error?.message || error) };
  }
}

async function dispatchById(eventId, options = {}) {
  return processClaimed(await claimOne({ eventId, force: options.force === true }));
}

async function retryDue(options = {}) {
  const requested = Number(options.limit || DEFAULT_BATCH_SIZE);
  const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), MAX_BATCH_SIZE) : DEFAULT_BATCH_SIZE;
  const summary = { processed: 0, synced: 0, failed: 0 };
  for (let index = 0; index < limit; index += 1) {
    const event = await claimOne();
    if (!event) break;
    const result = await processClaimed(event);
    if (result.processed) summary.processed += 1;
    if (result.synced) summary.synced += 1;
    else if (result.processed) summary.failed += 1;
  }
  return summary;
}

module.exports = {
  EVENT_NAME,
  PLAN_EVENT_NAME,
  eventIdFor,
  eventPayload,
  planEventIdFor,
  planEventPayload,
  retryDelayMs,
  enqueue,
  enqueuePlanPurchase,
  claimOne,
  processClaimed,
  dispatchById,
  retryDue,
};
