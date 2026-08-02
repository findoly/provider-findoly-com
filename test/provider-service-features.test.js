const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateSaleOutcome } = require("../utils/lead-status");

const root = path.join(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("marketplace category filter cannot expand beyond provider categories", () => {
  const marketplace = source("services/marketplace/marketplace-service.js");
  assert.match(marketplace, /providerCategories\(provider\)/);
  assert.match(marketplace, /categories\.includes\(requestedCategory\)/);
  assert.match(marketplace, /return \{ _id: \{ \$exists: false \} \}/);
});

test("marketplace query uses denormalized availability counters and bounded date filters", () => {
  const marketplace = source("services/marketplace/marketplace-service.js");
  for (const field of [
    "marketplaceAvailable",
    "marketplaceStatus",
    "remainingUnlocks",
    "unlockedCount",
    "providerConfirmedCount",
    "priority",
    "startDate",
    "endDate",
  ]) {
    assert.match(marketplace, new RegExp(field));
  }
  assert.match(marketplace, /const scanLimit = Math\.min\(500/);
  assert.match(marketplace, /while \(selected\.length < limit \+ 1\)/);
  assert.doesNotMatch(marketplace, /const maxBatches = 4/);
  assert.match(marketplace, /parseIsoDateFilter/);
  assert.match(marketplace, /assertDateRange/);
});

test("provider feedback requires a mandatory sale outcome before database access", () => {
  assert.deepEqual(validateSaleOutcome({ outcome: "confirmed" }), {
    outcome: "confirmed",
    outcomeNote: "",
  });
  assert.throws(
    () => validateSaleOutcome({ outcome: "" }),
    (error) => error.code === "PROVIDER_OUTCOME_REQUIRED" && error.status === 400,
  );
  const leadService = source("services/lead/lead-service.js");
  const validationPosition = leadService.indexOf("validateLeadFeedback(input)");
  const databasePosition = leadService.indexOf("findUnlock(providerId, identifier", validationPosition);
  assert.ok(validationPosition >= 0);
  assert.ok(databasePosition > validationPosition);
});
