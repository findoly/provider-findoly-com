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
    customerRequirementRaw: "Customer said this privately to the CRM employee.",
    providerRequirementTitle: "Two CCTV cameras need inspection and possible replacement",
    providerRequirementDetails: "Customer has two CCTV cameras with no video output and requires inspection. Repair is preferred, with replacement acceptable if repair is not possible.",
    serviceType: "CCTV Repair",
    priority: "high",
    city: "Mumbai",
    state: "Maharashtra",
    pincode: "400064",
    name: "Private Customer",
    mobile: "9999999999",
    email: "private@example.com",
    addressLine: "Private customer address",
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

test("provider marketplace exposes the approved description before unlock", () => {
  const lead = presentLead(enquiry(), null, {});
  assert.equal(
    lead.providerRequirementDetails,
    enquiry().providerRequirementDetails,
  );
});

test("pre-unlock provider presentation keeps raw requirement and customer contact private", () => {
  const lead = presentLead(enquiry(), null, {});
  assert.equal(Object.hasOwn(lead, "customerRequirementRaw"), false);
  assert.equal(Object.hasOwn(lead, "customerName"), false);
  assert.equal(Object.hasOwn(lead, "customerMobile"), false);
  assert.equal(Object.hasOwn(lead, "customerEmail"), false);
  assert.equal(Object.hasOwn(lead, "customerAddress"), false);
});

test("provider detail keeps the approved description after unlock and reveals customer contact", () => {
  const lead = presentLead(enquiry(), {
    providerLeadUnlockId: "UNLOCK-1",
    unlockedAt: new Date(),
  }, {});
  assert.equal(
    lead.providerRequirementDetails,
    enquiry().providerRequirementDetails,
  );
  assert.equal(lead.customerName, "Private Customer");
  assert.equal(lead.customerMobile, "9999999999");
  assert.equal(lead.customerEmail, "private@example.com");
  assert.equal(lead.customerAddress, "Private customer address");
  assert.equal(Object.hasOwn(lead, "customerRequirementRaw"), false);
});

test("legacy marketplace lead title still falls back to requirementTitle", () => {
  const lead = presentLead({
    ...enquiry(),
    providerRequirementTitle: "",
    providerRequirementDetails: "",
  }, null, {});
  assert.equal(lead.leadTitle, "Legacy CCTV requirement");
  assert.equal(lead.providerRequirementDetails, "");
});

test("marketplace projection includes approved wording but excludes raw requirement and customer contact", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../services/marketplace/marketplace-service.js"),
    "utf8",
  );
  const projection = source.slice(
    source.indexOf("const MARKETPLACE_SELECT"),
    source.indexOf("function publicId"),
  );
  assert.match(projection, /providerRequirementTitle:\s*1/);
  assert.match(projection, /providerRequirementDetails:\s*1/);
  assert.doesNotMatch(projection, /customerRequirementRaw:\s*1/);
  assert.doesNotMatch(projection, /name:\s*1/);
  assert.doesNotMatch(projection, /mobile:\s*1/);
  assert.doesNotMatch(projection, /email:\s*1/);
  assert.doesNotMatch(projection, /addressLine:\s*1/);
});

test("provider enquiry schema matches CRM approved wording field limits", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../models/Enquiry.js"),
    "utf8",
  );
  assert.match(source, /providerRequirementTitle:[^\n]*maxlength:\s*300/);
  assert.match(source, /providerRequirementDetails:[^\n]*maxlength:\s*2000/);
});
