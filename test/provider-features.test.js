const test = require("node:test");
const assert = require("node:assert/strict");

const {
  creditsFromPaise,
  paiseFromCredits,
  leadCostCredits,
} = require("../utils/credits");
const {
  validateActivityStatus,
  validateLeadFeedback,
} = require("../utils/lead-status");
const { presentProvider, providerCategories } = require("../utils/provider");
const { presentLead } = require("../utils/lead");
const {
  haversineDistanceKm,
  isMarketplaceVisible,
  isMarketplaceWithinAge,
  marketplaceVisibleAt,
  stageForDistance,
} = require("../utils/marketplace-radius");
const { getPlan, directPaymentQuote } = require("../config/plans");

test("rupee-backed balances and lead prices are exposed as 1:1 credits", () => {
  assert.equal(creditsFromPaise(10000), 100);
  assert.equal(paiseFromCredits(25), 2500);
  assert.equal(leadCostCredits({ leadPricePaise: 7500 }), 75);
  assert.equal(
    leadCostCredits({ leadPricePaise: 7500, leadCostCredits: 40 }),
    40,
  );

  const provider = presentProvider({ walletBalancePaise: 12345 });
  assert.equal(provider.walletCredits, 123.45);
});

test("provider categories are deduplicated and empty values are removed", () => {
  assert.deepEqual(
    providerCategories({ categorySlugs: ["grooming", "", "grooming", "vet"] }),
    ["grooming", "vet"],
  );
});

test("sale outcome is mandatory while activity status remains optional", () => {
  assert.deepEqual(
    validateLeadFeedback({ outcome: "Confirmed" }),
    {
      outcome: "confirmed",
      outcomeNote: "",
      status: "",
      reason: "",
      note: "",
    },
  );

  assert.throws(
    () => validateLeadFeedback({ status: "contacted" }),
    (error) => error.code === "PROVIDER_OUTCOME_REQUIRED",
  );

  assert.deepEqual(
    validateActivityStatus({
      status: "On Hold",
      note: "Customer will confirm tomorrow",
    }),
    {
      status: "on_hold",
      reason: "",
      note: "Customer will confirm tomorrow",
    },
  );

  assert.throws(
    () => validateActivityStatus({ status: "rejected", reason: "other" }),
    (error) => error.code === "LEAD_STATUS_NOTE_REQUIRED",
  );
});

test("marketplace uses the approved 20 km to open-network visibility stages", () => {
  assert.equal(stageForDistance(20).delayMinutes, 0);
  assert.equal(stageForDistance(20.1).delayMinutes, 10);
  assert.equal(stageForDistance(50).delayMinutes, 10);
  assert.equal(stageForDistance(50.1).delayMinutes, 30);
  assert.equal(stageForDistance(100).delayMinutes, 30);
  assert.equal(stageForDistance(100.1).delayMinutes, 60);
  assert.equal(stageForDistance(null), null);

  const publishedAt = new Date("2026-07-18T10:00:00.000Z");
  assert.equal(
    marketplaceVisibleAt(publishedAt, 20).toISOString(),
    "2026-07-18T10:00:00.000Z",
  );
  assert.equal(
    marketplaceVisibleAt(publishedAt, 50).toISOString(),
    "2026-07-18T10:10:00.000Z",
  );
  assert.equal(
    marketplaceVisibleAt(publishedAt, 100).toISOString(),
    "2026-07-18T10:30:00.000Z",
  );
  assert.equal(
    marketplaceVisibleAt(publishedAt, 101).toISOString(),
    "2026-07-18T11:00:00.000Z",
  );
  assert.equal(
    marketplaceVisibleAt(publishedAt, null).toISOString(),
    "2026-07-18T11:00:00.000Z",
  );

  assert.equal(
    isMarketplaceVisible(
      { marketplacePublishedAt: publishedAt, providerDistanceKm: null },
      new Date("2026-07-18T10:59:59.000Z"),
    ),
    false,
  );
  assert.equal(
    isMarketplaceVisible(
      { marketplacePublishedAt: publishedAt, providerDistanceKm: null },
      new Date("2026-07-18T11:00:00.000Z"),
    ),
    true,
  );
  assert.equal(
    isMarketplaceWithinAge(
      new Date("2026-01-18T10:00:00.000Z"),
      new Date("2026-07-18T10:00:00.000Z"),
    ),
    true,
  );
  assert.equal(
    isMarketplaceWithinAge(
      new Date("2026-01-17T23:59:59.000Z"),
      new Date("2026-07-18T10:00:00.000Z"),
    ),
    false,
  );
  assert.equal(haversineDistanceKm(null, null, 19.076, 72.8777), null);
  assert.ok(haversineDistanceKm(19.076, 72.8777, 19.076, 72.8777) < 0.1);
});

test("saved provider outcome and activity are returned only after successful unlock", () => {
  const enquiry = {
    enquiryId: "lead-1",
    categorySlug: "painting",
    leadPricePaise: 5000,
  };
  const unlock = {
    providerLeadUnlockId: "unlock-1",
    enquiryId: "lead-1",
    unlockMethod: "credits",
    providerSaleOutcome: "confirmed",
    providerSaleOutcomeNote: "Booked for Monday",
    providerLeadStatus: "follow_up",
    providerLeadNote: "Final service date pending",
  };

  const unlocked = presentLead(enquiry, unlock);
  assert.equal(unlocked.leadCostCredits, 50);
  assert.equal(unlocked.providerSaleOutcome, "confirmed");
  assert.equal(unlocked.providerLeadStatus, "follow_up");

  const locked = presentLead(enquiry);
  assert.equal(locked.providerSaleOutcome, undefined);
  assert.equal(locked.providerLeadStatus, undefined);
});

test("plan pricing applies monthly GST and includes yearly GST", () => {
  const starterMonthly = getPlan("starter", "monthly");
  assert.equal(starterMonthly.baseCredits, 1000);
  assert.equal(starterMonthly.bonusCredits, 0);
  assert.equal(starterMonthly.totalCredits, 1000);
  assert.equal(starterMonthly.gstIncluded, false);
  assert.equal(starterMonthly.gstAmountPaise, 17982);
  assert.equal(starterMonthly.totalAmountPaise, 117882);

  const growthYearly = getPlan("growth", "yearly");
  assert.equal(growthYearly.baseCredits, 36000);
  assert.equal(growthYearly.bonusCredits, 10800);
  assert.equal(growthYearly.totalCredits, 46800);
  assert.equal(growthYearly.gstIncluded, true);
  assert.equal(growthYearly.totalAmountPaise, 3599900);

  const scaleMonthly = getPlan("scale", "monthly");
  assert.equal(scaleMonthly.baseCredits, 10000);
  assert.equal(scaleMonthly.bonusCredits, 1000);
  assert.equal(scaleMonthly.totalCredits, 11000);
});

test("direct lead payment adds 18 percent GST without creating credits", () => {
  assert.deepEqual(directPaymentQuote(100000), {
    subtotalPaise: 100000,
    gstAmountPaise: 18000,
    totalAmountPaise: 118000,
    gstRatePercent: 18,
    gstIncluded: false,
  });
});
