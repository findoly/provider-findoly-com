"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const marketplaceService = require("../services/marketplace/marketplace-service");
const { boundedCount } = require("../services/dashboard/dashboard-service");

const publishedAt = new Date("2026-08-26T00:00:00.000Z");

function validProvider(overrides = {}) {
  return {
    serviceLatitude: 19.076,
    serviceLongitude: 72.8777,
    serviceLocationSource: "google_geocoding",
    ...overrides,
  };
}

function validLead(overrides = {}) {
  return {
    marketplacePublishedAt: publishedAt,
    locationLatitude: 19.076,
    locationLongitude: 72.8777,
    locationPincode: "400001",
    locationSource: "google_geocoding",
    pincode: "400001",
    ...overrides,
  };
}

test("marketplace distance uses verified matching coordinates", () => {
  const result = marketplaceService.visibilityFor(validProvider(), validLead());
  assert.equal(result.providerDistanceKm, 0);
  assert.equal(result.marketplaceVisibleAt.getTime(), publishedAt.getTime());
});

test("marketplace rejects provider coordinates marked manual_pincode", () => {
  const result = marketplaceService.visibilityFor(
    validProvider({ serviceLocationSource: "manual_pincode" }),
    validLead(),
  );
  assert.equal(result.providerDistanceKm, null);
  assert.equal(result.marketplaceVisibleAt.getTime(), publishedAt.getTime() + 60 * 60 * 1000);
});

test("marketplace rejects lead coordinates marked manual_pincode", () => {
  const result = marketplaceService.visibilityFor(
    validProvider(),
    validLead({ locationSource: "manual_pincode" }),
  );
  assert.equal(result.providerDistanceKm, null);
  assert.equal(result.marketplaceVisibleAt.getTime(), publishedAt.getTime() + 60 * 60 * 1000);
});

test("marketplace rejects lead coordinates when canonical PIN differs", () => {
  const result = marketplaceService.visibilityFor(
    validProvider(),
    validLead({ pincode: "400001", locationPincode: "400002" }),
  );
  assert.equal(result.providerDistanceKm, null);
  assert.equal(result.marketplaceVisibleAt.getTime(), publishedAt.getTime() + 60 * 60 * 1000);
});

test("marketplace rejects out-of-range coordinates", () => {
  const invalidProvider = marketplaceService.visibilityFor(
    validProvider({ serviceLatitude: 91 }),
    validLead(),
  );
  const invalidLead = marketplaceService.visibilityFor(
    validProvider(),
    validLead({ locationLongitude: 181 }),
  );
  assert.equal(invalidProvider.providerDistanceKm, null);
  assert.equal(invalidLead.providerDistanceKm, null);
});

function fakeCountModel(rowCount) {
  return {
    find() {
      return {
        select() { return this; },
        sort() { return this; },
        limit() { return this; },
        async lean() {
          return Array.from({ length: rowCount }, (_, index) => ({ _id: String(index + 1) }));
        },
      };
    },
  };
}

test("dashboard bounded pending count distinguishes total from preview size", async () => {
  assert.deepEqual(await boundedCount(fakeCountModel(7), { providerSaleOutcome: "" }, 10), {
    value: 7,
    capped: false,
  });
  assert.deepEqual(await boundedCount(fakeCountModel(11), { providerSaleOutcome: "" }, 10), {
    value: 10,
    capped: true,
  });
});

test("marketplace and dashboard views keep the approved mobile contracts", () => {
  const leadListView = fs.readFileSync(path.join(__dirname, "..", "views", "lead", "index.ejs"), "utf8");
  const leadShowView = fs.readFileSync(path.join(__dirname, "..", "views", "lead", "show.ejs"), "utf8");
  const dashboardView = fs.readFileSync(path.join(__dirname, "..", "views", "dashboard", "index.ejs"), "utf8");

  assert.match(leadListView, /if \(value < 1\) return '<1 km away';/);
  assert.match(leadShowView, /if \(distance < 1\) return '<1 km away';/);
  assert.match(leadListView, /provider-decision-card\.is-marketplace \.provider-action-benefits/);
  assert.match(leadListView, /lead\.providerRequirementDetails\.trim\(\)/);
  assert.match(leadShowView, /x-show="lead\.providerRequirementDetails"/);
  assert.doesNotMatch(leadShowView, /x-show="isUnlocked && lead\.providerRequirementDetails"/);
  assert.match(dashboardView, /\/leads\?status=unlocked&amp;outcome=pending/);
  assert.match(dashboardView, /Showing the oldest/);
});
