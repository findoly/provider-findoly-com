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

test("unlocked lead status update stores status, reason, note and provider", async () => {
  const originalFindOneAndUpdate = LeadDistribution.findOneAndUpdate;
  let capturedQuery;
  let capturedUpdate;

  LeadDistribution.findOneAndUpdate = async (query, update) => {
    capturedQuery = query;
    capturedUpdate = update;
    return {
      toObject: () => ({
        leadDistributionId: "lead-1",
        providerId: "provider-1",
        categorySlug: "grooming",
        status: "unlocked",
        contactUnlocked: true,
        leadPricePaise: 2500,
        ...update.$set,
      }),
    };
  };

  try {
    const result = await leadService.updateStatus(provider, "lead-1", {
      status: "rejected",
      reason: "other",
      note: "Customer requested a service outside our scope",
    });

    assert.equal(capturedQuery.providerId, "provider-1");
    assert.equal(capturedQuery.contactUnlocked, true);
    assert.equal(capturedUpdate.$set.providerLeadStatus, "rejected");
    assert.equal(capturedUpdate.$set.providerLeadReason, "other");
    assert.equal(capturedUpdate.$set.providerLeadStatusUpdatedBy, "provider-1");
    assert.equal(result.providerLeadStatus, "rejected");
    assert.equal(result.providerLeadNote, "Customer requested a service outside our scope");
  } finally {
    LeadDistribution.findOneAndUpdate = originalFindOneAndUpdate;
  }
});
