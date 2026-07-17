const test = require("node:test");
const assert = require("node:assert/strict");

const LeadDistribution = require("../models/LeadDistribution");
const leadService = require("../services/lead/lead-service");

const provider = {
  providerId: "provider-1",
  categorySlugs: ["grooming", "veterinary"],
};

test("available lead filtering rejects categories not assigned to provider", async () => {
  await assert.rejects(
    leadService.list(provider, {
      status: "offered",
      categorySlug: "boarding",
    }),
    (error) => error.code === "CATEGORY_NOT_ASSIGNED" && error.status === 403,
  );
});

test("locked lead detail is hidden after provider category mismatch", async () => {
  const originalFindOne = LeadDistribution.findOne;
  LeadDistribution.findOne = () => ({
    lean: async () => ({
      leadDistributionId: "lead-1",
      providerId: "provider-1",
      categorySlug: "boarding",
      status: "offered",
      contactUnlocked: false,
    }),
  });

  try {
    await assert.rejects(
      leadService.get(provider, "lead-1"),
      (error) => error.code === "LEAD_NOT_FOUND" && error.status === 404,
    );
  } finally {
    LeadDistribution.findOne = originalFindOne;
  }
});

test("provider feedback requires a mandatory sale outcome before database access", async () => {
  await assert.rejects(
    leadService.updateFeedback(provider, "lead-1", {
      status: "follow_up",
      note: "Customer asked us to call tomorrow",
    }),
    (error) => error.code === "PROVIDER_OUTCOME_REQUIRED" && error.status === 400,
  );
});
