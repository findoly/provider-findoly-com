"use strict";

const ProviderCrmSyncEvent = require("../../models/ProviderCrmSyncEvent");
const ProviderLeadUnlock = require("../../models/ProviderLeadUnlock");
const uuid = require("../../utils/uuid");
const crmService = require("./crm-service");

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const LOCK_LEASE_MS = 2 * 60 * 1000;
const BASE_RETRY_MS = 30 * 1000;
const MAX_RETRY_MS = 6 * 60 * 60 * 1000;

function maximumAttempts(env = process.env) {
  const value = Number(env.CRM_SYNC_MAX_ATTEMPTS || 20);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 20;
}

function retentionDays(env = process.env) {
  const value = Number(env.CRM_SYNC_EVENT_RETENTION_DAYS || 30);
  return Number.isInteger(value) && value >= 1 && value <= 365 ? value : 30;
}

function purgeAfterDate(now = new Date(), env = process.env) {
  return new Date(now.getTime() + retentionDays(env) * 24 * 60 * 60 * 1000);
}

function retryDelayMs(attemptNumber) {
  const exponent = Math.max(0, Math.min(10, Number(attemptNumber || 1) - 1));
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** exponent));
}

function pendingSyncFields(eventName, now = new Date()) {
  return {
    crmSyncStatus: "pending",
    crmSyncEvent: eventName,
    crmSyncCurrentEventId: "",
    crmSyncError: "",
    crmSyncNextAttemptAt: now,
    crmSyncLockedAt: null,
    crmSyncLockToken: "",
    crmSyncUpdatedAt: now,
  };
}

function eventPayload(
  unlock = {},
  eventName = unlock.crmSyncEvent,
  integrationEventId = "",
  integrationEventSequence = 0,
) {
  const providerName = unlock.providerBusinessName || unlock.providerName || "";
  const common = {
    integrationEventId,
    integrationEventSequence,
    idempotencySuffix: integrationEventId,
    providerLeadUnlockId: unlock.providerLeadUnlockId,
    enquiryId: unlock.enquiryId,
    providerId: unlock.providerId,
    providerName,
  };
  if (eventName === "provider_feedback_updated") {
    return {
      ...common,
      outcome: unlock.providerSaleOutcome,
      outcomeNote: unlock.providerSaleOutcomeNote,
      activityStatus: unlock.providerLeadStatus,
      reason: unlock.providerLeadReason,
      note: unlock.providerLeadNote,
      eventAt: unlock.providerSaleOutcomeUpdatedAt || unlock.crmSyncUpdatedAt || new Date(),
    };
  }
  return {
    ...common,
    unlockMethod: unlock.unlockMethod,
    creditsUsed: unlock.chargedCredits,
    unlockedAt: unlock.unlockedAt,
    eventAt: unlock.unlockedAt,
  };
}

function outboxIdempotencyKey(eventName, unlock = {}, eventId = "") {
  const unlockId = String(unlock.providerLeadUnlockId || "").trim();
  if (eventName === "provider_lead_unlocked") return `${eventName}:${unlockId}`;
  return `${eventName}:${unlockId}:${eventId}`;
}

function eventDate(unlock = {}, eventName, fallback = new Date()) {
  const value = eventName === "provider_feedback_updated"
    ? unlock.providerSaleOutcomeUpdatedAt || unlock.crmSyncUpdatedAt
    : unlock.unlockedAt;
  const date = value ? new Date(value) : fallback;
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function unlockSummaryFromEvent(event = {}, now = new Date()) {
  const status = event.status === "synced"
    ? "synced"
    : event.status === "pending" ? "pending" : "failed";
  return {
    crmSyncStatus: status,
    crmSyncEvent: event.eventName,
    crmSyncCurrentEventId: event.crmSyncEventId,
    crmSyncError: event.lastError || "",
    crmSyncAttemptCount: Number(event.attemptCount || 0),
    crmSyncLastAttemptAt: event.lastAttemptAt || null,
    crmSyncNextAttemptAt: event.nextAttemptAt || null,
    crmSyncLockedAt: event.lockedAt || null,
    crmSyncLockToken: event.lockToken || "",
    crmSyncUpdatedAt: now,
  };
}

async function repairUnlockSummary(event, options = {}) {
  const providerLeadUnlockId = String(event?.providerLeadUnlockId || "").trim();
  const crmSyncEventId = String(event?.crmSyncEventId || "").trim();
  if (!providerLeadUnlockId || !crmSyncEventId) return { matchedCount: 0 };
  const allowedCurrentIds = ["", null, crmSyncEventId];
  if (options.replaceCurrentEventId) allowedCurrentIds.push(options.replaceCurrentEventId);
  const update = {
    $set: unlockSummaryFromEvent(event, options.now || new Date()),
  };
  const sequence = Number(event.sequence || 0);
  if (Number.isSafeInteger(sequence) && sequence > 0) {
    update.$max = { crmSyncSequence: sequence };
  }
  return ProviderLeadUnlock.updateOne(
    {
      providerLeadUnlockId,
      $or: [
        { crmSyncCurrentEventId: { $exists: false } },
        ...allowedCurrentIds.map((value) => ({ crmSyncCurrentEventId: value })),
      ],
    },
    update,
    options.session ? { session: options.session } : undefined,
  );
}

async function enqueue(eventName, unlock = {}, options = {}) {
  if (!["provider_lead_unlocked", "provider_feedback_updated"].includes(eventName)) {
    throw Object.assign(new Error("CRM sync event is invalid"), { code: "CRM_SYNC_EVENT_INVALID" });
  }
  const providerLeadUnlockId = String(unlock.providerLeadUnlockId || "").trim();
  if (!providerLeadUnlockId) {
    throw Object.assign(new Error("Provider lead unlock ID is required for CRM sync"), {
      code: "CRM_SYNC_UNLOCK_ID_REQUIRED",
    });
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const crmSyncEventId = String(options.crmSyncEventId || uuid()).trim();
  const eventAt = eventDate(unlock, eventName, now);
  const idempotencyKey = options.idempotencyKey
    || outboxIdempotencyKey(eventName, unlock, crmSyncEventId);
  const sessionOptions = options.session ? { session: options.session } : {};

  // Idempotency is checked before reserving a sequence so normal replays do not
  // create gaps or replace a newer summary event.
  let existingQuery = ProviderCrmSyncEvent.findOne({ idempotencyKey });
  if (options.session && typeof existingQuery?.session === "function") {
    existingQuery = existingQuery.session(options.session);
  }
  const existing = await existingQuery;
  if (existing) {
    await repairUnlockSummary(existing, { session: options.session, now });
    return existing.toObject ? existing.toObject() : existing;
  }

  // The sequence and outbox insert run in the caller's MongoDB transaction for
  // normal unlock/feedback flows. This gives every committed aggregate event a
  // stable monotonic ordering value before any HTTP delivery is attempted.
  const sequencedUnlock = await ProviderLeadUnlock.findOneAndUpdate(
    { providerLeadUnlockId },
    {
      $inc: { crmSyncSequence: 1 },
      $set: {
        crmSyncStatus: "pending",
        crmSyncEvent: eventName,
        crmSyncCurrentEventId: crmSyncEventId,
        crmSyncError: "",
        crmSyncNextAttemptAt: now,
        crmSyncLockedAt: null,
        crmSyncLockToken: "",
        crmSyncUpdatedAt: now,
      },
    },
    { new: true, ...sessionOptions },
  );
  if (!sequencedUnlock) {
    throw Object.assign(new Error("Provider lead unlock was not found while queuing CRM sync"), {
      code: "CRM_SYNC_UNLOCK_NOT_FOUND",
    });
  }

  const sequence = Number(sequencedUnlock.crmSyncSequence || 0);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw Object.assign(new Error("CRM sync sequence allocation failed"), {
      code: "CRM_SYNC_SEQUENCE_INVALID",
    });
  }
  const document = {
    crmSyncEventId,
    idempotencyKey,
    providerLeadUnlockId,
    enquiryId: String(unlock.enquiryId || sequencedUnlock.enquiryId || "").trim(),
    providerId: String(unlock.providerId || sequencedUnlock.providerId || "").trim(),
    eventName,
    sequence,
    eventAt,
    payload: eventPayload(unlock, eventName, crmSyncEventId, sequence),
    status: "pending",
    attemptCount: 0,
    lastError: "",
    nextAttemptAt: now,
    lockedAt: null,
    lockToken: "",
  };

  try {
    const [created] = await ProviderCrmSyncEvent.create([document], sessionOptions);
    return created.toObject ? created.toObject() : created;
  } catch (error) {
    if (error?.code !== 11000 || options.session) throw error;

    // A non-transactional legacy backfill can race another worker. Resolve the
    // winning idempotent event and only repair the summary if it still points to
    // this losing reservation; never overwrite a newer event summary.
    const duplicate = await ProviderCrmSyncEvent.findOne({ idempotencyKey });
    if (!duplicate) throw error;
    await repairUnlockSummary(duplicate, {
      now,
      replaceCurrentEventId: crmSyncEventId,
    });
    return duplicate.toObject ? duplicate.toObject() : duplicate;
  }
}

async function backfillLegacyPending(options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit || DEFAULT_BATCH_SIZE)));
  const query = {
    crmSyncStatus: { $in: ["pending", "failed"] },
    $or: [
      { crmSyncCurrentEventId: { $exists: false } },
      { crmSyncCurrentEventId: "" },
      { crmSyncCurrentEventId: null },
    ],
    ...(options.providerLeadUnlockId
      ? { providerLeadUnlockId: String(options.providerLeadUnlockId).trim() }
      : {}),
  };
  const rows = await ProviderLeadUnlock.find(query)
    .sort({ crmSyncNextAttemptAt: 1, unlockedAt: 1, _id: 1 })
    .limit(limit)
    .lean();
  let created = 0;
  for (const unlock of rows) {
    const eventName = unlock.crmSyncEvent === "provider_feedback_updated"
      ? "provider_feedback_updated"
      : "provider_lead_unlocked";
    const legacyAt = eventDate(unlock, eventName, new Date());
    const idempotencyKey = eventName === "provider_lead_unlocked"
      ? outboxIdempotencyKey(eventName, unlock)
      : `legacy:${eventName}:${unlock.providerLeadUnlockId}:${legacyAt.toISOString()}`;
    await enqueue(eventName, unlock, { now: legacyAt, idempotencyKey });
    created += 1;
  }
  return created;
}

async function claimOne({ providerLeadUnlockId = "", crmSyncEventId = "", force = false, includeDeadLetter = false, statuses = null, now = new Date() } = {}) {
  const lockToken = uuid();
  const lockExpiredAt = new Date(now.getTime() - LOCK_LEASE_MS);
  const dueCondition = force
    ? {}
    : { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] };
  const allowedStatuses = Array.isArray(statuses) && statuses.length
    ? statuses.filter((value) => ["pending", "failed", "dead_letter"].includes(value))
    : (includeDeadLetter ? ["pending", "failed", "dead_letter"] : ["pending", "failed"]);
  const query = {
    ...(providerLeadUnlockId ? { providerLeadUnlockId } : {}),
    ...(crmSyncEventId ? { crmSyncEventId } : {}),
    status: { $in: allowedStatuses.length ? allowedStatuses : ["pending", "failed"] },
    ...dueCondition,
    $and: [
      { $or: [{ lockedAt: null }, { lockedAt: { $lte: lockExpiredAt } }] },
    ],
  };
  return ProviderCrmSyncEvent.findOneAndUpdate(
    query,
    { $set: { lockedAt: now, lockToken, updatedAt: now } },
    {
      new: true,
      sort: force && providerLeadUnlockId
        ? { sequence: -1, eventAt: -1, _id: -1 }
        : { nextAttemptAt: 1, eventAt: 1, _id: 1 },
    },
  ).lean();
}

async function updateUnlockSummary(event, fields) {
  await ProviderLeadUnlock.updateOne(
    {
      providerLeadUnlockId: event.providerLeadUnlockId,
      crmSyncCurrentEventId: event.crmSyncEventId,
    },
    { $set: fields },
  );
}

async function deliverClaimed(event, now = new Date()) {
  if (!event) return { processed: false, reason: "not_due_or_locked" };
  const attemptNumber = Number(event.attemptCount || 0) + 1;
  try {
    const response = event.eventName === "provider_feedback_updated"
      ? await crmService.sendProviderFeedback(event.payload || {})
      : await crmService.sendProviderUnlock(event.payload || {});
    if (response.skipped) {
      throw Object.assign(
        new Error(response.reason || "CRM delivery was not completed"),
        { code: "CRM_DELIVERY_INCOMPLETE" },
      );
    }
    const result = await ProviderCrmSyncEvent.updateOne(
      { crmSyncEventId: event.crmSyncEventId, lockToken: event.lockToken },
      {
        $set: {
          status: "synced",
          attemptCount: attemptNumber,
          lastError: "",
          lastAttemptAt: now,
          nextAttemptAt: null,
          lockedAt: null,
          lockToken: "",
          syncedAt: now,
          purgeAfterAt: purgeAfterDate(now),
          updatedAt: now,
        },
      },
    );
    if (result.matchedCount === 0) {
      return { processed: false, synced: false, reason: "lease_lost", crmSyncEventId: event.crmSyncEventId };
    }
    await updateUnlockSummary(event, {
      crmSyncStatus: "synced",
      crmSyncError: "",
      crmSyncAttemptCount: attemptNumber,
      crmSyncLastAttemptAt: now,
      crmSyncNextAttemptAt: null,
      crmSyncLockedAt: null,
      crmSyncLockToken: "",
      crmSyncUpdatedAt: now,
    });
    return {
      processed: true,
      synced: true,
      crmSyncEventId: event.crmSyncEventId,
      providerLeadUnlockId: event.providerLeadUnlockId,
      deliveryWarning: response.deliveryWarning || "",
    };
  } catch (error) {
    const deadLetter = attemptNumber >= maximumAttempts();
    const retryingDeadLetter = event.status === "dead_letter";
    const nextAttemptAt = deadLetter
      ? (retryingDeadLetter
        ? new Date(now.getTime() + retryDelayMs(attemptNumber))
        : null)
      : new Date(now.getTime() + retryDelayMs(attemptNumber));
    const errorMessage = String(error?.message || "CRM sync failed").slice(0, 1000);
    const result = await ProviderCrmSyncEvent.updateOne(
      { crmSyncEventId: event.crmSyncEventId, lockToken: event.lockToken },
      {
        $set: {
          status: deadLetter ? "dead_letter" : "failed",
          attemptCount: attemptNumber,
          lastError: errorMessage,
          lastAttemptAt: now,
          nextAttemptAt,
          lockedAt: null,
          lockToken: "",
          updatedAt: now,
        },
      },
    );
    if (result.matchedCount === 0) {
      return { processed: false, synced: false, reason: "lease_lost", crmSyncEventId: event.crmSyncEventId };
    }
    await updateUnlockSummary(event, {
      crmSyncStatus: "failed",
      crmSyncAttemptCount: attemptNumber,
      crmSyncError: deadLetter ? `Dead letter after ${attemptNumber} attempts: ${errorMessage}`.slice(0, 1000) : errorMessage,
      crmSyncLastAttemptAt: now,
      crmSyncNextAttemptAt: nextAttemptAt,
      crmSyncLockedAt: null,
      crmSyncLockToken: "",
      crmSyncUpdatedAt: now,
    });
    return {
      processed: true,
      synced: false,
      crmSyncEventId: event.crmSyncEventId,
      providerLeadUnlockId: event.providerLeadUnlockId,
      nextAttemptAt,
      error: errorMessage,
      deadLetter,
    };
  }
}

async function currentEventId(providerLeadUnlockId) {
  const query = ProviderLeadUnlock.findOne({ providerLeadUnlockId })
    .select({ crmSyncCurrentEventId: 1 });
  const unlock = await query.lean();
  return String(unlock?.crmSyncCurrentEventId || "").trim();
}

async function syncById(providerLeadUnlockId, options = {}) {
  const normalizedId = String(providerLeadUnlockId || "").trim();
  if (!normalizedId) return { processed: false, synced: false, reason: "provider_lead_unlock_id_required" };
  const now = options.now instanceof Date ? options.now : new Date();
  let eventId = await currentEventId(normalizedId);
  if (!eventId) {
    await backfillLegacyPending({ providerLeadUnlockId: normalizedId, limit: 1 });
    eventId = await currentEventId(normalizedId);
  }
  if (!eventId) return { processed: false, synced: false, reason: "current_event_not_found" };
  const claimed = await claimOne({
    providerLeadUnlockId: normalizedId,
    crmSyncEventId: eventId,
    force: options.force === true,
    now,
  });
  return deliverClaimed(claimed, now);
}

async function replayDeadLetter(crmSyncEventId, options = {}) {
  const eventId = String(crmSyncEventId || "").trim();
  if (!eventId) return { processed: false, synced: false, reason: "crm_sync_event_id_required" };
  const now = options.now instanceof Date ? options.now : new Date();
  const claimed = await claimOne({ crmSyncEventId: eventId, force: true, statuses: ["dead_letter"], now });
  if (!claimed) {
    return { processed: false, synced: false, reason: "dead_letter_not_found" };
  }
  return deliverClaimed(claimed, now);
}

async function retryDue(options = {}) {
  const limit = Math.min(MAX_BATCH_SIZE, Math.max(1, Number(options.limit || DEFAULT_BATCH_SIZE)));
  await backfillLegacyPending({ limit });
  const summary = { processed: 0, synced: 0, failed: 0, deadLetter: 0, leaseLost: 0 };
  for (let index = 0; index < limit; index += 1) {
    const claimed = await claimOne({
      now: new Date(),
      includeDeadLetter: options.includeDeadLetter === true,
    });
    if (!claimed) break;
    const result = await deliverClaimed(claimed, new Date());
    if (!result.processed) {
      if (result.reason === "lease_lost") summary.leaseLost += 1;
      continue;
    }
    summary.processed += 1;
    if (result.synced) summary.synced += 1;
    else if (result.deadLetter) summary.deadLetter += 1;
    else summary.failed += 1;
  }
  return summary;
}

module.exports = {
  BASE_RETRY_MS,
  DEFAULT_BATCH_SIZE,
  LOCK_LEASE_MS,
  MAX_BATCH_SIZE,
  backfillLegacyPending,
  maximumAttempts,
  purgeAfterDate,
  repairUnlockSummary,
  retentionDays,
  claimOne,
  deliverClaimed,
  enqueue,
  eventPayload,
  outboxIdempotencyKey,
  pendingSyncFields,
  unlockSummaryFromEvent,
  retryDelayMs,
  replayDeadLetter,
  retryDue,
  syncById,
};
