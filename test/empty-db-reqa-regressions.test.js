"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

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

function withIntegrationEnv(work) {
  const previous = {
    CRM_API_BASE_URL: process.env.CRM_API_BASE_URL,
    COMMUNICATION_EVENT_API_TOKEN: process.env.COMMUNICATION_EVENT_API_TOKEN,
  };
  process.env.CRM_API_BASE_URL = "https://crm.example.com";
  process.env.COMMUNICATION_EVENT_API_TOKEN = "t".repeat(40);
  return Promise.resolve()
    .then(work)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

const payload = Object.freeze({
  integrationEventId: "event-123",
  integrationEventSequence: 7,
  providerLeadUnlockId: "unlock-123",
});

function acknowledgement(overrides = {}) {
  return {
    accepted: true,
    eventName: "provider_lead_unlocked",
    integrationEventId: payload.integrationEventId,
    integrationEventSequence: payload.integrationEventSequence,
    providerLeadUnlockId: payload.providerLeadUnlockId,
    ...overrides,
  };
}

test("Provider accepts only the CRM's explicit matching acknowledgement", async () => {
  let returnedBody = {
    success: true,
    data: { acknowledgement: acknowledgement(), channelDeliveries: [] },
  };
  const service = compile("services/integration/crm-service.js", {
    "../../utils/http": {
      async fetchJson() { return { response: { ok: true }, body: returnedBody, rawBody: "" }; },
    },
  });

  await withIntegrationEnv(async () => {
    const accepted = await service.sendProviderUnlock(payload);
    assert.equal(accepted.synced, true);
    assert.equal(accepted.acknowledgement.integrationEventId, payload.integrationEventId);

    const invalidBodies = [
      {},
      { success: true, data: {} },
      { success: true, data: { acknowledgement: { ...acknowledgement(), accepted: "true" } } },
      { success: true, data: { acknowledgement: acknowledgement({ integrationEventId: "wrong" }) } },
      { success: true, data: { acknowledgement: acknowledgement({ integrationEventSequence: "7" }) } },
      { success: true, data: { acknowledgement: acknowledgement({ eventName: "provider_feedback_updated" }) } },
    ];
    for (const body of invalidBodies) {
      returnedBody = body;
      await assert.rejects(
        service.sendProviderUnlock(payload),
        (error) => error?.code === "CRM_COMMUNICATION_FAILED" && error?.status === 502,
      );
    }
  });
});

function lead(id, longitude) {
  return {
    _id: id,
    enquiryId: id,
    categorySlug: "painting",
    marketplaceAvailable: true,
    marketplaceStatus: "published",
    marketplacePublishedAt: new Date("2026-08-02T08:00:00.000Z"),
    marketplaceExpiresAt: new Date("2026-08-03T12:00:00.000Z"),
    remainingUnlocks: 1,
    locationLatitude: 0,
    locationLongitude: longitude,
  };
}

function marketplaceFromBatches(initialBatches, limit = 10) {
  const batches = initialBatches.map((batch) => [...batch]);
  let calls = 0;
  const Enquiry = {
    find() {
      const rows = batches[calls++] || [];
      return {
        select() { return this; },
        sort() { return this; },
        limit() { return this; },
        maxTimeMS() { return this; },
        async lean() { return rows; },
      };
    },
  };
  const ProviderLeadUnlock = {
    find() {
      return { select() { return this; }, async lean() { return []; } };
    },
  };
  const service = compile("services/marketplace/marketplace-service.js", {
    "../../models/Enquiry": Enquiry,
    "../../models/ProviderLeadUnlock": ProviderLeadUnlock,
    "../../utils/provider": {
      providerCategories: () => ["painting"],
      providerIdentity: () => "provider-1",
    },
    "../../utils/pagination": {
      getPagination: () => ({ limit, cursor: "" }),
      normalizeSort: (value) => value,
      decodeCursor: (value) => value || null,
      buildCursorCondition: () => ({}),
      mergeQuery: (left, right) => ({ $and: [left, right] }),
      encodeCursor: (row) => `cursor:${row?._id || "none"}`,
    },
    "../../utils/normalization": {
      normalizeSearchText: (value) => String(value || "").trim().toLowerCase(),
      prefixRegex: (value) => new RegExp(`^${value}`),
    },
  });
  return { service, calls: () => calls };
}

test("Marketplace list scans past four sparse batches and returns the first real match", async () => {
  const distantBatches = Array.from({ length: 4 }, (_, batch) =>
    Array.from({ length: 41 }, (_, index) => lead(`far-${batch}-${index}`, 2)));
  const { service, calls } = marketplaceFromBatches([...distantBatches, [lead("near-1", 0.01)]], 10);
  const result = await service.listMarketplace(
    { providerId: "provider-1", serviceLatitude: 0, serviceLongitude: 0 },
    { maxDistanceKm: 10 },
  );
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].enquiryId, "near-1");
  assert.equal(result.pagination.hasNext, false);
  assert.equal(calls(), 5);
});

test("Marketplace count does not report zero when a match is beyond the old 1000-row scan cap", async () => {
  const distantBatches = Array.from({ length: 20 }, (_, batch) =>
    Array.from({ length: 51 }, (_, index) => lead(`far-count-${batch}-${index}`, 2)));
  const { service, calls } = marketplaceFromBatches([...distantBatches, [lead("near-count", 0.01)]]);
  const result = await service.countMarketplace(
    { providerId: "provider-1", serviceLatitude: 0, serviceLongitude: 0 },
    { cap: 1, batchSize: 50, now: new Date("2026-08-02T12:00:00.000Z"), filters: { maxDistanceKm: 10 } },
  );
  assert.deepEqual(result, { value: 1, capped: false });
  assert.equal(calls(), 21);
});

test("Impossible and reversed marketplace dates are rejected instead of normalized", () => {
  const { parseIsoDateFilter, assertDateRange } = require("../utils/date-filter");
  assert.throws(() => parseIsoDateFilter("2026-02-30"), /Date filter is invalid/);
  assert.throws(() => parseIsoDateFilter("2025-02-29"), /Date filter is invalid/);
  assert.equal(parseIsoDateFilter("2024-02-29").toISOString(), "2024-02-29T00:00:00.000Z");
  assert.throws(
    () => assertDateRange(parseIsoDateFilter("2026-08-03"), parseIsoDateFilter("2026-08-02", { endOfDay: true })),
    /Date range is invalid/,
  );
});

test("Forced sync claims the unlock's current event and never an old dead letter", async () => {
  let claimQuery;
  const current = { crmSyncCurrentEventId: "new-event" };
  const event = {
    crmSyncEventId: "new-event",
    providerLeadUnlockId: "unlock-1",
    eventName: "provider_lead_unlocked",
    payload: payload,
    status: "pending",
    attemptCount: 0,
    lockToken: "",
  };
  const service = compile("services/integration/crm-sync-service.js", {
    "../../models/ProviderLeadUnlock": {
      findOne() { return { select() { return this; }, async lean() { return current; } }; },
      async updateOne() { return { matchedCount: 1 }; },
    },
    "../../models/ProviderCrmSyncEvent": {
      findOneAndUpdate(query, update) {
        claimQuery = query;
        Object.assign(event, update.$set);
        return { async lean() { return { ...event }; } };
      },
      async updateOne() { return { matchedCount: 1 }; },
    },
    "../../utils/uuid": () => "lease-1",
    "./crm-service": {
      async sendProviderUnlock() { return { synced: true }; },
      async sendProviderFeedback() { return { synced: true }; },
    },
  });
  const result = await service.syncById("unlock-1", { force: true });
  assert.equal(result.synced, true);
  assert.equal(claimQuery.crmSyncEventId, "new-event");
  assert.deepEqual(claimQuery.status.$in, ["pending", "failed"]);
});

test("Marketplace list fails safely when the source cursor cannot advance", async () => {
  const repeated = Array.from({ length: 41 }, (_, index) => lead(`same-${index}`, 2));
  const { service, calls } = marketplaceFromBatches([repeated, repeated], 10);
  await assert.rejects(
    service.listMarketplace(
      { providerId: "provider-1", serviceLatitude: 0, serviceLongitude: 0 },
      { maxDistanceKm: 10 },
    ),
    (error) => error?.code === "MARKETPLACE_CURSOR_STALLED" && error?.status === 503,
  );
  assert.equal(calls(), 2);
});

test("Marketplace count fails safely when the source cursor cannot advance", async () => {
  const repeated = Array.from({ length: 51 }, (_, index) => lead(`same-count-${index}`, 2));
  const { service, calls } = marketplaceFromBatches([repeated, repeated]);
  await assert.rejects(
    service.countMarketplace(
      { providerId: "provider-1", serviceLatitude: 0, serviceLongitude: 0 },
      { cap: 10, batchSize: 50, now: new Date("2026-08-02T12:00:00.000Z"), filters: { maxDistanceKm: 10 } },
    ),
    (error) => error?.code === "MARKETPLACE_CURSOR_STALLED" && error?.status === 503,
  );
  assert.equal(calls(), 2);
});
