"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { presentLead } = require("../utils/lead");

function enquiry() {
  return {
    enquiryId: "ENQ-1",
    categorySlug: "cctv",
    category: "CCTV",
    requirementTitle: "Legacy CCTV requirement",
    providerRequirementTitle: "Two CCTV cameras need inspection and possible replacement",
    providerRequirementDetails: "Customer has two CCTV cameras with no video output and requires inspection. Repair is preferred, with replacement acceptable if repair is not possible.",
    serviceType: "CCTV Repair",
    priority: "high",
    city: "Mumbai",
    state: "Maharashtra",
    pincode: "400064",
    leadPricePaise: 50000,
    remainingUnlocks: 3,
    maxProviderUnlocks: 3,
    marketplaceAvailable: true,
    marketplaceStatus: "published",
  };
}

test("provider marketplace uses the approved short requirement title", () => {
  const lead = presentLead(enquiry(), null, {});
  assert.equal(
    lead.leadTitle,
    "Two CCTV cameras need inspection and possible replacement",
  );
  assert.equal(lead.providerRequirementTitle, lead.leadTitle);
});

test("provider detail hides the long requirement before unlock", () => {
  const lead = presentLead(enquiry(), null, {});
  assert.equal(Object.hasOwn(lead, "providerRequirementDetails"), false);
});

test("provider detail exposes the approved long requirement after unlock", () => {
  const lead = presentLead(enquiry(), {
    providerLeadUnlockId: "UNLOCK-1",
    unlockedAt: new Date(),
  }, {});
  assert.equal(
    lead.providerRequirementDetails,
    enquiry().providerRequirementDetails,
  );
});


test("marketplace projection includes only the approved short requirement wording", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../services/marketplace/marketplace-service.js"),
    "utf8",
  );
  const projection = source.slice(
    source.indexOf("const MARKETPLACE_SELECT"),
    source.indexOf("function publicId"),
  );
  assert.match(projection, /providerRequirementTitle:\s*1/);
  assert.doesNotMatch(projection, /providerRequirementDetails:\s*1/);
});
