"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const marketplaceService = require("../services/marketplace/marketplace-service");
const {
  MARKETPLACE_MAX_AGE_DAYS,
  isMarketplaceWithinAge,
  marketplaceAgeCutoff,
} = require("../utils/marketplace-radius");

const root = path.resolve(__dirname, "..");
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function provider(providerId = "provider-a") {
  return {
    providerId,
    categorySlugs: ["veterinary"],
    serviceLatitude: 19.076,
    serviceLongitude: 72.8777,
    serviceLocationSource: "google_geocoding",
  };
}

function lead(overrides = {}) {
  return {
    enquiryId: "lead-1",
    categorySlug: "veterinary",
    marketplaceAvailable: true,
    marketplaceStatus: "published",
    marketplaceClosureReason: "",
    marketplacePublishedAt: new Date("2026-10-02T02:00:00.001Z"),
    marketplaceExpiresAt: new Date("2026-10-10T00:00:00.000Z"),
    remainingUnlocks: 5,
    locationLatitude: 19.076,
    locationLongitude: 72.8777,
    locationPincode: "400001",
    locationSource: "google_geocoding",
    pincode: "400001",
    ...overrides,
  };
}

test("provider marketplace expires at the strict three-day boundary", () => {
  const now = new Date("2026-10-05T02:00:00.000Z");
  assert.equal(MARKETPLACE_MAX_AGE_DAYS, 3);
  assert.equal(
    marketplaceAgeCutoff(now).toISOString(),
    "2026-10-02T02:00:00.000Z",
  );
  assert.equal(
    isMarketplaceWithinAge(new Date("2026-10-02T02:00:00.001Z"), now),
    true,
  );
  assert.equal(
    isMarketplaceWithinAge(new Date("2026-10-02T02:00:00.000Z"), now),
    false,
  );
});

test("marketplace query includes only fresh public leads plus this provider's active pick", () => {
  const now = new Date("2026-10-05T02:00:00.000Z");
  const query = marketplaceService.buildMarketplaceQuery(provider(), {}, now);
  assert.equal(query.categorySlug, "veterinary");
  assert.equal(Array.isArray(query.$and), true);

  const lifecycle = query.$and[0].$or;
  assert.equal(lifecycle.length, 2);

  const publicBranch = lifecycle[0];
  assert.equal(publicBranch.marketplaceAvailable, true);
  assert.equal(publicBranch.marketplaceStatus, "published");
  assert.equal(
    publicBranch.marketplacePublishedAt.$gt.toISOString(),
    "2026-10-02T02:00:00.000Z",
  );

  const pickedBranch = lifecycle[1];
  assert.equal(pickedBranch.marketplaceAvailable, false);
  assert.equal(pickedBranch.marketplaceStatus, "closed");
  assert.equal(pickedBranch.marketplaceClosureReason, "provider_pending");
  assert.equal(pickedBranch.marketplacePickedProviderId, "provider-a");
  assert.equal(pickedBranch.marketplacePickedUntil.$gt.toISOString(), now.toISOString());
});

test("an active picked requirement stays visible only to its picker after three days", () => {
  const now = new Date("2026-10-05T02:00:00.000Z");
  const picked = lead({
    marketplaceAvailable: false,
    marketplaceStatus: "closed",
    marketplaceClosureReason: "provider_pending",
    marketplacePublishedAt: new Date("2026-10-01T00:00:00.000Z"),
    marketplacePickedProviderId: "provider-a",
    marketplacePickedUntil: new Date("2026-10-05T02:10:00.000Z"),
    remainingUnlocks: 4,
  });

  assert.equal(marketplaceService.isVisibleNow(provider("provider-a"), picked, now), true);
  assert.equal(marketplaceService.isVisibleNow(provider("provider-b"), picked, now), false);
});

test("a stale unpicked requirement is not visible even if its legacy expiry is later", () => {
  const now = new Date("2026-10-05T02:00:00.000Z");
  assert.equal(
    marketplaceService.isVisibleNow(
      provider(),
      lead({ marketplacePublishedAt: new Date("2026-10-02T02:00:00.000Z") }),
      now,
    ),
    false,
  );
});

test("direct-payment reservation writes and clears provider pick ownership", () => {
  const payment = source("services/wallet/lead-payment-service.js");
  assert.match(payment, /marketplacePickedProviderId:\s*providerId/);
  assert.match(payment, /marketplacePickedUntil:\s*reservedUntil/);
  assert.match(payment, /marketplacePickedProviderId:\s*""/);
  assert.match(payment, /marketplacePickedUntil:\s*null/);
});

test("released reservations can reopen only inside the provider marketplace age window", () => {
  const assignment = source("services/lead/provider-assignment-service.js");
  assert.match(assignment, /isMarketplaceWithinAge\(lead\.marketplacePublishedAt, now\)/);
});
