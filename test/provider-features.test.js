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
  competitionLevel,
  discountedCredits,
  discountPercentForUnlocks,
} = require("../utils/marketplace");
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

test("marketplace competition and discount tiers use previous successful unlocks", () => {
  assert.equal(competitionLevel(0), "low");
  assert.equal(competitionLevel(2), "medium");
  assert.equal(competitionLevel(4), "high");

  assert.equal(discountPercentForUnlocks(0), 0);
  assert.equal(discountPercentForUnlocks(1), 20);
  assert.equal(discountPercentForUnlocks(3), 40);
  assert.equal(discountPercentForUnlocks(5), 50);
  assert.equal(discountPercentForUnlocks(8), 75);

  assert.deepEqual(discountedCredits(100, 3), {
    baseCredits: 100,
    effectiveCredits: 60,
    discountPercent: 40,
    savingsCredits: 40,
    previousUnlocks: 3,
  });
});

test("saved provider outcome and activity are returned only after contact unlock", () => {
  const source = {
    leadDistributionId: "lead-1",
    status: "unlocked",
    contactUnlocked: true,
    leadPricePaise: 5000,
    providerSaleOutcome: "confirmed",
    providerSaleOutcomeNote: "Booked for Monday",
    providerLeadStatus: "follow_up",
    providerLeadNote: "Final service date pending",
  };

  const unlocked = presentLead(source);
  assert.equal(unlocked.leadCostCredits, 50);
  assert.equal(unlocked.providerSaleOutcome, "confirmed");
  assert.equal(unlocked.providerLeadStatus, "follow_up");

  const locked = presentLead({ ...source, status: "offered", contactUnlocked: false });
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
