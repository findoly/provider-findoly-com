const test = require("node:test");
const assert = require("node:assert/strict");

const {
  creditsFromPaise,
  paiseFromCredits,
  leadCostCredits,
} = require("../utils/credits");
const { validateLeadStatus } = require("../utils/lead-status");
const { presentProvider, providerCategories } = require("../utils/provider");
const { presentLead } = require("../utils/lead");
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

test("lead status requires a valid reason and Other requires a note", () => {
  assert.deepEqual(
    validateLeadStatus({
      status: "On Hold",
      reason: "schedule pending",
      note: "Customer will confirm tomorrow",
    }),
    {
      status: "on_hold",
      reason: "schedule_pending",
      note: "Customer will confirm tomorrow",
    },
  );

  assert.throws(
    () => validateLeadStatus({ status: "rejected", reason: "other" }),
    (error) => error.code === "LEAD_STATUS_NOTE_REQUIRED",
  );

  assert.throws(
    () => validateLeadStatus({ status: "confirmed", reason: "invalid_contact" }),
    (error) => error.code === "LEAD_STATUS_REASON_INVALID",
  );
});

test("saved provider lead status is returned only after contact unlock", () => {
  const source = {
    leadDistributionId: "lead-1",
    status: "unlocked",
    contactUnlocked: true,
    leadPricePaise: 5000,
    providerLeadStatus: "confirmed",
    providerLeadReason: "service_booked",
    providerLeadNote: "Booked for Monday",
  };

  const unlocked = presentLead(source);
  assert.equal(unlocked.leadCostCredits, 50);
  assert.equal(unlocked.providerLeadStatus, "confirmed");
  assert.equal(unlocked.providerLeadReason, "service_booked");

  const locked = presentLead({ ...source, status: "offered", contactUnlocked: false });
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
