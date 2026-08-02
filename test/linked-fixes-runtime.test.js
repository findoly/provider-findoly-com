"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { verifySharedIndexes } = require("../db/shared-contract");

function indexConnection(overrides = {}) {
  const exact = {
    providers: [
      { name: "provider_mobile_unique", key: { normalizedMobile: 1 }, unique: true, partialFilterExpression: { normalizedMobile: { $exists: true, $gt: "" } } },
      { name: "provider_whatsapp_unique", key: { normalizedWhatsappNumber: 1 }, unique: true, partialFilterExpression: { normalizedWhatsappNumber: { $exists: true, $gt: "" } } },
      { name: "provider_email_unique", key: { normalizedEmail: 1 }, unique: true, partialFilterExpression: { normalizedEmail: { $exists: true, $gt: "" } } },
    ],
    providerjoinrequests: [
      { name: "normalizedMobile_1", key: { normalizedMobile: 1 }, unique: true, partialFilterExpression: { $or: [{ status: "new" }, { status: "contacted" }] } },
      { name: "normalizedEmail_1_status_1_createdAt_-1", key: { normalizedEmail: 1, status: 1, createdAt: -1 } },
    ],
    contactidentities: [
      { name: "key_1", key: { key: 1 }, unique: true },
    ],
    ...overrides,
  };
  return {
    db: {
      collection(name) {
        return { listIndexes() { return { async toArray() { return exact[name] || []; } }; } };
      },
    },
  };
}

test("shared index verification rejects unique indexes missing partial filters", async () => {
  const invalidProviders = indexConnection().db.collection("providers").listIndexes;
  void invalidProviders;
  const connection = indexConnection({
    providers: [
      { name: "provider_mobile_unique", key: { normalizedMobile: 1 }, unique: true },
      { name: "provider_whatsapp_unique", key: { normalizedWhatsappNumber: 1 }, unique: true, partialFilterExpression: { normalizedWhatsappNumber: { $exists: true, $gt: "" } } },
      { name: "provider_email_unique", key: { normalizedEmail: 1 }, unique: true, partialFilterExpression: { normalizedEmail: { $exists: true, $gt: "" } } },
    ],
  });
  await assert.rejects(
    verifySharedIndexes(connection),
    (error) => error?.code === "SHARED_INDEXES_MISSING" && error.missingIndexes.includes("unique provider mobile"),
  );
  assert.deepEqual(await verifySharedIndexes(indexConnection()), { verified: 6 });
});

function compile(relativePath, mocks) {
  const filename = path.join(__dirname, "..", relativePath);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = (request) => (
    Object.prototype.hasOwnProperty.call(mocks, request)
      ? mocks[request]
      : Module.createRequire(filename)(request)
  );
  loaded._compile(fs.readFileSync(filename, "utf8"), filename);
  return loaded.exports;
}

test("CRM sync failure is persisted with backoff and a later retry reaches synced", async () => {
  const event = {
    crmSyncEventId: "event-1",
    providerLeadUnlockId: "unlock-1",
    eventName: "provider_lead_unlocked",
    payload: { providerLeadUnlockId: "unlock-1" },
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: new Date("2026-08-01T00:00:00.000Z"),
    lockedAt: null,
    lockToken: "",
  };
  const summary = { crmSyncCurrentEventId: "event-1" };
  let calls = 0;
  const outbox = {
    findOneAndUpdate(_query, update) {
      Object.assign(event, update.$set);
      return { async lean() { return { ...event }; } };
    },
    async updateOne(query, update) {
      assert.equal(query.crmSyncEventId, event.crmSyncEventId);
      assert.equal(query.lockToken, event.lockToken);
      Object.assign(event, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  const unlockModel = {
    findOne(query) {
      assert.equal(query.providerLeadUnlockId, "unlock-1");
      return { select() { return this; }, async lean() { return { ...summary }; } };
    },
    async updateOne(query, update) {
      assert.equal(query.crmSyncCurrentEventId, "event-1");
      Object.assign(summary, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  const service = compile("services/integration/crm-sync-service.js", {
    "../../models/ProviderCrmSyncEvent": outbox,
    "../../models/ProviderLeadUnlock": unlockModel,
    "../../utils/uuid": () => `lock-${calls + 1}`,
    "./crm-service": {
      async sendProviderUnlock() {
        calls += 1;
        if (calls === 1) throw new Error("temporary CRM outage");
        return { synced: true };
      },
      async sendProviderFeedback() { return { synced: true }; },
    },
  });

  const first = await service.syncById("unlock-1", { force: true, now: new Date("2026-08-02T00:00:00.000Z") });
  assert.equal(first.synced, false);
  assert.equal(event.status, "failed");
  assert.equal(event.attemptCount, 1);
  assert.ok(event.nextAttemptAt > event.lastAttemptAt);
  assert.equal(summary.crmSyncStatus, "failed");

  const second = await service.syncById("unlock-1", { force: true, now: new Date("2026-08-02T00:01:00.000Z") });
  assert.equal(second.synced, true);
  assert.equal(event.status, "synced");
  assert.equal(event.attemptCount, 2);
  assert.equal(event.nextAttemptAt, null);
  assert.equal(summary.crmSyncStatus, "synced");
});


test("CRM sync refuses an empty identifier instead of claiming another event", async () => {
  let claims = 0;
  const service = compile("services/integration/crm-sync-service.js", {
    "../../models/ProviderCrmSyncEvent": {
      findOneAndUpdate() { claims += 1; throw new Error("must not claim"); },
    },
    "../../models/ProviderLeadUnlock": {},
    "../../utils/uuid": () => "lock",
    "./crm-service": {},
  });
  assert.deepEqual(await service.syncById("  "), {
    processed: false,
    synced: false,
    reason: "provider_lead_unlock_id_required",
  });
  assert.equal(claims, 0);
});

test("CRM channel warnings do not retry an event already accepted by CRM", async () => {
  const event = {
    crmSyncEventId: "event-warning",
    providerLeadUnlockId: "unlock-warning",
    eventName: "provider_lead_unlocked",
    payload: { providerLeadUnlockId: "unlock-warning" },
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: new Date("2026-08-01T00:00:00.000Z"),
    lockedAt: null,
    lockToken: "",
  };
  const summary = { crmSyncCurrentEventId: "event-warning" };
  const outbox = {
    findOneAndUpdate(_query, update) {
      Object.assign(event, update.$set);
      return { async lean() { return { ...event }; } };
    },
    async updateOne(_query, update) {
      Object.assign(event, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  const service = compile("services/integration/crm-sync-service.js", {
    "../../models/ProviderCrmSyncEvent": outbox,
    "../../models/ProviderLeadUnlock": {
      findOne() { return { select() { return this; }, async lean() { return { ...summary }; } }; },
      async updateOne(_query, update) { Object.assign(summary, update.$set); return { matchedCount: 1 }; },
    },
    "../../utils/uuid": () => "lock-warning",
    "./crm-service": {
      async sendProviderUnlock() {
        return { synced: true, deliveryFailed: true, deliveryWarning: "email: temporary failure" };
      },
      async sendProviderFeedback() { return { synced: true }; },
    },
  });
  const result = await service.syncById("unlock-warning", { force: true });
  assert.equal(result.synced, true);
  assert.equal(result.deliveryWarning, "email: temporary failure");
  assert.equal(event.status, "synced");
  assert.equal(event.nextAttemptAt, null);
  assert.equal(summary.crmSyncStatus, "synced");
});

test("exhausted CRM retries move to dead-letter state without a hot retry loop", async () => {
  const previous = process.env.CRM_SYNC_MAX_ATTEMPTS;
  process.env.CRM_SYNC_MAX_ATTEMPTS = "2";
  const event = {
    crmSyncEventId: "event-dead",
    providerLeadUnlockId: "unlock-dead",
    eventName: "provider_lead_unlocked",
    payload: { providerLeadUnlockId: "unlock-dead" },
    status: "failed",
    attemptCount: 1,
    nextAttemptAt: new Date("2026-08-01T00:00:00.000Z"),
    lockedAt: null,
    lockToken: "",
  };
  const summary = { crmSyncCurrentEventId: "event-dead" };
  const outbox = {
    findOneAndUpdate(_query, update) {
      Object.assign(event, update.$set);
      return { async lean() { return { ...event }; } };
    },
    async updateOne(_query, update) {
      Object.assign(event, update.$set);
      return { matchedCount: 1 };
    },
  };
  const service = compile("services/integration/crm-sync-service.js", {
    "../../models/ProviderCrmSyncEvent": outbox,
    "../../models/ProviderLeadUnlock": {
      findOne() { return { select() { return this; }, async lean() { return { ...summary }; } }; },
      async updateOne(_query, update) { Object.assign(summary, update.$set); return { matchedCount: 1 }; },
    },
    "../../utils/uuid": () => "lock-dead",
    "./crm-service": {
      async sendProviderUnlock() { throw new Error("persistent outage"); },
      async sendProviderFeedback() { throw new Error("persistent outage"); },
    },
  });
  try {
    const result = await service.syncById("unlock-dead", { force: true });
    assert.equal(result.deadLetter, true);
    assert.equal(event.status, "dead_letter");
    assert.equal(event.nextAttemptAt, null);
    assert.match(summary.crmSyncError, /Dead letter after 2 attempts/);
  } finally {
    if (previous === undefined) delete process.env.CRM_SYNC_MAX_ATTEMPTS;
    else process.env.CRM_SYNC_MAX_ATTEMPTS = previous;
  }
});

test("a failed manual dead-letter retry is backed off instead of hot-looping", async () => {
  const previous = process.env.CRM_SYNC_MAX_ATTEMPTS;
  process.env.CRM_SYNC_MAX_ATTEMPTS = "2";
  const now = new Date("2026-08-02T12:00:00.000Z");
  const event = {
    crmSyncEventId: "event-dead-retry",
    providerLeadUnlockId: "unlock-dead-retry",
    eventName: "provider_lead_unlocked",
    payload: { providerLeadUnlockId: "unlock-dead-retry" },
    status: "dead_letter",
    attemptCount: 2,
    lockToken: "dead-retry-lock",
  };
  const service = compile("services/integration/crm-sync-service.js", {
    "../../models/ProviderCrmSyncEvent": {
      async updateOne(_query, update) {
        Object.assign(event, update.$set);
        return { matchedCount: 1 };
      },
    },
    "../../models/ProviderLeadUnlock": { async updateOne() { return { matchedCount: 1 }; } },
    "../../utils/uuid": () => "unused",
    "./crm-service": {
      async sendProviderUnlock() { throw new Error("still unavailable"); },
      async sendProviderFeedback() { throw new Error("still unavailable"); },
    },
  });
  try {
    const result = await service.deliverClaimed({ ...event }, now);
    assert.equal(result.deadLetter, true);
    assert.ok(result.nextAttemptAt > now);
    assert.equal(event.status, "dead_letter");
    assert.ok(event.nextAttemptAt > now);
  } finally {
    if (previous === undefined) delete process.env.CRM_SYNC_MAX_ATTEMPTS;
    else process.env.CRM_SYNC_MAX_ATTEMPTS = previous;
  }
});

test("transactional outbox preserves unlock and feedback as ordered separate events", async () => {
  const created = [];
  const summaryUpdates = [];
  let eventId = 0;
  let aggregateSequence = 0;
  const outbox = {
    async findOne() { return null; },
    async create([document], options) {
      assert.equal(options.session.id, "session-1");
      const row = { ...document, toObject() { return { ...this, toObject: undefined }; } };
      created.push(row);
      return [row];
    },
  };
  const service = compile("services/integration/crm-sync-service.js", {
    "../../models/ProviderCrmSyncEvent": outbox,
    "../../models/ProviderLeadUnlock": {
      async findOneAndUpdate(query, update, options) {
        assert.equal(options.session.id, "session-1");
        aggregateSequence += update.$inc.crmSyncSequence;
        summaryUpdates.push({ query, update });
        return {
          providerLeadUnlockId: "unlock-queue",
          enquiryId: "enquiry-queue",
          providerId: "provider-queue",
          crmSyncSequence: aggregateSequence,
        };
      },
      async updateOne() { return { matchedCount: 1 }; },
    },
    "../../utils/uuid": () => `event-${++eventId}`,
    "./crm-service": {},
  });
  const unlock = {
    providerLeadUnlockId: "unlock-queue",
    enquiryId: "enquiry-queue",
    providerId: "provider-queue",
    unlockedAt: new Date("2026-08-02T10:00:00.000Z"),
  };
  await service.enqueue("provider_lead_unlocked", unlock, { session: { id: "session-1" } });
  await service.enqueue("provider_feedback_updated", {
    ...unlock,
    providerSaleOutcome: "confirmed",
    providerSaleOutcomeUpdatedAt: new Date("2026-08-02T10:01:00.000Z"),
  }, { session: { id: "session-1" } });
  assert.equal(created.length, 2);
  assert.deepEqual(created.map((row) => row.eventName), ["provider_lead_unlocked", "provider_feedback_updated"]);
  assert.deepEqual(created.map((row) => row.sequence), [1, 2]);
  assert.notEqual(created[0].crmSyncEventId, created[1].crmSyncEventId);
  assert.equal(created[0].payload.integrationEventId, created[0].crmSyncEventId);
  assert.equal(created[1].payload.integrationEventId, created[1].crmSyncEventId);
  assert.deepEqual(created.map((row) => row.payload.integrationEventSequence), [1, 2]);
  assert.equal(summaryUpdates.length, 2);
  assert.equal(summaryUpdates[1].update.$set.crmSyncCurrentEventId, created[1].crmSyncEventId);
});

test("an idempotent outbox replay repairs a missing shared summary without allocating another sequence", async () => {
  const existing = {
    crmSyncEventId: "existing-event",
    idempotencyKey: "provider_lead_unlocked:unlock-existing",
    providerLeadUnlockId: "unlock-existing",
    eventName: "provider_lead_unlocked",
    sequence: 4,
    status: "pending",
    attemptCount: 1,
    nextAttemptAt: new Date("2026-08-02T10:05:00.000Z"),
    toObject() { return { ...this, toObject: undefined }; },
  };
  let repaired;
  const service = compile("services/integration/crm-sync-service.js", {
    "../../models/ProviderCrmSyncEvent": {
      async findOne() { return existing; },
      async create() { throw new Error("must not create a duplicate"); },
    },
    "../../models/ProviderLeadUnlock": {
      async findOneAndUpdate() { throw new Error("must not allocate another sequence"); },
      async updateOne(query, update, options) {
        assert.equal(options.session.id, "session-existing");
        repaired = { query, update };
        return { matchedCount: 1 };
      },
    },
    "../../utils/uuid": () => "unused-event",
    "./crm-service": {},
  });

  const result = await service.enqueue("provider_lead_unlocked", {
    providerLeadUnlockId: "unlock-existing",
    enquiryId: "lead-existing",
    providerId: "provider-existing",
    unlockedAt: new Date("2026-08-02T10:00:00.000Z"),
  }, { session: { id: "session-existing" } });

  assert.equal(result.crmSyncEventId, "existing-event");
  assert.equal(repaired.update.$set.crmSyncCurrentEventId, "existing-event");
  assert.equal(repaired.update.$set.crmSyncStatus, "pending");
  assert.equal(repaired.update.$max.crmSyncSequence, 4);
  assert.ok(repaired.query.$or.some((condition) => condition.crmSyncCurrentEventId === ""));
});

test("CRM retry worker shutdown waits for an in-flight outbox batch", async () => {
  let releaseRetry;
  const worker = compile("services/integration/crm-sync-worker.js", {
    "./crm-sync-service": {
      retryDue() {
        return new Promise((resolve) => { releaseRetry = resolve; });
      },
    },
  });

  const running = worker.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  let stopped = false;
  const stopping = worker.stopCrmSyncWorker().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releaseRetry({ processed: 0, synced: 0, failed: 0 });
  await Promise.all([running, stopping]);
  assert.equal(stopped, true);
});

test("CRM retry command honours and validates the documented max event option", () => {
  const script = compile("scripts/retry-crm-sync.js", {
    "mongoose": { async disconnect() {} },
    "../db/connection": async () => {},
    "../services/integration/crm-sync-service": { DEFAULT_BATCH_SIZE: 25, async retryDue() { return { processed: 0, synced: 0, failed: 0 }; } },
  });
  assert.equal(script.maximumEvents(["--max=17"], {}), 17);
  assert.equal(script.maximumEvents([], { CRM_SYNC_RETRY_MAX_EVENTS: "41" }), 41);
  assert.equal(script.maximumEvents([], { CRM_SYNC_RETRY_MAX_BATCHES: "3" }), 75);
  assert.throws(() => script.maximumEvents(["--max=0"], {}), /between 1 and 10000/);
  assert.throws(() => script.maximumEvents(["--max=abc"], {}), /between 1 and 10000/);
});

function marketplaceServiceFor(rows, unlockedIds = []) {
  const Enquiry = {
    find() {
      const chain = {
        select() { return this; },
        sort() { return this; },
        limit() { return this; },
        maxTimeMS() { return this; },
        async lean() { return rows; },
      };
      return chain;
    },
  };
  const ProviderLeadUnlock = {
    find() {
      return {
        select() { return this; },
        async lean() { return unlockedIds.map((enquiryId) => ({ enquiryId })); },
      };
    },
  };
  return compile("services/marketplace/marketplace-service.js", {
    "../../models/Enquiry": Enquiry,
    "../../models/ProviderLeadUnlock": ProviderLeadUnlock,
    "../../utils/provider": {
      providerCategories: () => ["painting"],
      providerIdentity: () => "provider-1",
    },
    "../../utils/marketplace-radius": Module.createRequire(__filename)("../utils/marketplace-radius"),
    "../../utils/pagination": {
      getPagination: () => ({ limit: 20, cursor: "" }),
      normalizeSort: (value) => value,
      decodeCursor: () => null,
      buildCursorCondition: () => ({}),
      mergeQuery: (left, right) => ({ $and: [left, right] }),
      encodeCursor: () => "next",
    },
    "../../utils/normalization": {
      normalizeSearchText: (value) => String(value || "").trim().toLowerCase(),
      prefixRegex: (value) => new RegExp(`^${value}`),
    },
  });
}

test("marketplace count applies distance and unlocked exclusion consistently", async () => {
  const now = new Date("2026-08-02T12:00:00.000Z");
  const baseLead = {
    _id: "lead-1",
    enquiryId: "enquiry-1",
    categorySlug: "painting",
    marketplaceAvailable: true,
    marketplaceStatus: "published",
    marketplacePublishedAt: new Date("2026-08-02T10:00:00.000Z"),
    marketplaceExpiresAt: new Date("2026-08-03T12:00:00.000Z"),
    remainingUnlocks: 1,
    locationLatitude: 0,
    locationLongitude: 2,
  };
  const provider = { providerId: "provider-1", categorySlugs: ["painting"], serviceLatitude: 0, serviceLongitude: 0 };
  const distant = marketplaceServiceFor([baseLead]);
  assert.deepEqual(
    await distant.countMarketplace(provider, { now, filters: { maxDistanceKm: 10 } }),
    { value: 0, capped: false },
  );

  const nearLead = { ...baseLead, locationLongitude: 0.01 };
  const unlocked = marketplaceServiceFor([nearLead], ["enquiry-1"]);
  assert.deepEqual(
    await unlocked.countMarketplace(provider, { now, filters: { maxDistanceKm: 10 } }),
    { value: 0, capped: false },
  );
});

test("provider plan state keeps active plan current and future plan upcoming", async () => {
  const active = {
    providerSubscriptionId: "sub-a",
    planCode: "A",
    planName: "Active",
    billingCycle: "monthly",
    startsAt: new Date("2026-08-01T00:00:00.000Z"),
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
  };
  const upcoming = {
    providerSubscriptionId: "sub-b",
    planCode: "B",
    planName: "Upcoming",
    billingCycle: "annual",
    startsAt: new Date("2026-09-01T00:00:00.000Z"),
    expiresAt: new Date("2027-09-01T00:00:00.000Z"),
  };
  let written;
  const Provider = {
    async findOneAndUpdate(_query, update) { written = update.$set; return { providerId: "provider-1", ...written }; },
  };
  let queryInFlight = false;
  const ProviderSubscription = {
    findOne(query) {
      const value = query.status === "active" ? active : upcoming;
      return {
        sort() { return this; },
        session() { return this; },
        async lean() {
          if (queryInFlight) throw new Error("parallel transaction query");
          queryInFlight = true;
          await new Promise((resolve) => setImmediate(resolve));
          queryInFlight = false;
          return value;
        },
      };
    },
  };
  const wallet = compile("services/wallet/wallet-service.js", {
    "razorpay": class Razorpay {},
    "../../models/Provider": Provider,
    "../../models/WalletTransaction": {},
    "../../models/PaymentOrder": {},
    "../../models/ProviderSubscription": ProviderSubscription,
    "../../utils/uuid": () => "uuid",
    "../../utils/pagination": { cursorPaginate() {}, getPagination() {} },
    "../../utils/provider": {
      providerIdentity: () => "provider-1",
      providerQuery: (providerId) => ({ providerId }),
      presentProvider: (value) => value,
    },
    "../../utils/transaction": { withTransaction() {} },
    "../../utils/credits": { creditsFromPaise: () => 0, paiseFromCredits: () => 0 },
    "../../config/plans": { getPlan() {}, listPlans: () => [] },
    "../billing/credit-service": {},
    "./lead-payment-service": { cancelLeadOrder() {}, createLeadOrder() {}, fulfillLeadOrder() {} },
  });
  await wallet.syncProviderPlanState("provider-1", new Date("2026-08-02T00:00:00.000Z"));
  assert.equal(written.currentPlanCode, "A");
  assert.equal(written.currentSubscriptionId, "sub-a");
  assert.equal(written.nextPlanCode, "B");
  assert.equal(written.nextSubscriptionId, "sub-b");
});
