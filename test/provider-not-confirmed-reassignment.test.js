"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");

function compileAssignment({ blocker = null, lead = null } = {}) {
  const filename = path.join(root, "services/lead/provider-assignment-service.js");
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));

  const unlockQuery = {
    select() { return this; },
    session() { return this; },
    async lean() { return blocker; },
  };
  const leadQuery = {
    session() { return this; },
    then(resolve) { return Promise.resolve(resolve(lead)); },
  };

  loaded.require = (request) => {
    if (request === "../../models/ProviderLeadUnlock") {
      return { findOne() { return unlockQuery; } };
    }
    if (request === "../../models/Enquiry") {
      return { findOne() { return leadQuery; } };
    }
    return Module.createRequire(filename)(request);
  };
  loaded._compile(fs.readFileSync(filename, "utf8"), filename);
  return loaded.exports;
}

test("unlock charging remains unchanged while Not Confirmed creates refund review state", () => {
  const leadService = source("services/lead/lead-service.js");
  const unlockModel = source("models/ProviderLeadUnlock.js");
  const leadView = source("views/lead/show.ejs");

  assert.match(leadService, /creditService\.consumeCredits\(providerId, costMinorCredits, session\)/);
  assert.match(leadService, /source: "lead_unlock"/);
  assert.match(leadService, /feedback\.outcome === "not_confirmed"[\s\S]*creditRefundStatus = "pending_review"/);
  assert.match(leadService, /markReadyForReassignment/);
  assert.match(unlockModel, /creditRefundStatus/);
  assert.match(unlockModel, /"pending_review", "refunded", "kept_charged"/);
  assert.match(leadView, /awaiting Findoly review/);
  assert.match(leadView, /Credits remain charged unless the Findoly team approves a reversal/);
});

test("another provider is blocked until every earlier provider is Not Confirmed", async () => {
  const service = compileAssignment({
    blocker: {
      providerLeadUnlockId: "unlock-1",
      providerId: "provider-1",
      providerSaleOutcome: "",
    },
  });

  await assert.rejects(
    service.assertNextProviderEligible("lead-1", "provider-2"),
    (error) => error.code === "PREVIOUS_PROVIDER_NOT_CLOSED" && error.status === 409,
  );

  const openService = compileAssignment({ blocker: null });
  await assert.doesNotReject(
    openService.assertNextProviderEligible("lead-1", "provider-2"),
  );
});

test("assignment stays managed after Not Confirmed without overwriting terminal states", async () => {
  const activeLead = {
    status: "approved",
    isActive: true,
    marketplaceExpiresAt: new Date(Date.now() + 3600000),
    marketplacePublishedAt: new Date(Date.now() - 3600000),
    marketplaceClosureReason: "",
    remainingUnlocks: 2,
    reservedUnlockCount: 0,
    async save() {},
    toObject() { return { ...this, save: undefined, toObject: undefined }; },
  };
  const active = compileAssignment({ blocker: null, lead: activeLead });
  const closed = await active.closeForActiveProvider("lead-1");
  assert.equal(closed.closed, true);
  assert.equal(activeLead.marketplaceAvailable, false);
  assert.equal(activeLead.marketplaceStatus, "closed");
  assert.equal(activeLead.marketplaceClosureReason, "provider_pending");

  const ready = await active.markReadyForReassignment("lead-1");
  assert.equal(ready.eligible, true);
  assert.equal(activeLead.marketplaceAvailable, false);
  assert.equal(activeLead.marketplaceStatus, "closed");
  assert.equal(activeLead.marketplaceClosureReason, "provider_pending");

  const expiredLead = {
    ...activeLead,
    marketplaceClosureReason: "expired",
    marketplaceExpiresAt: new Date(Date.now() - 1000),
    marketplaceAvailable: false,
    marketplaceStatus: "expired",
    async save() { throw new Error("terminal lead should not be saved"); },
  };
  const terminal = compileAssignment({ blocker: null, lead: expiredLead });
  const result = await terminal.closeForActiveProvider("lead-1");
  assert.equal(result.closed, false);
  assert.equal(result.reason, "lead_not_active");
  assert.equal(expiredLead.marketplaceClosureReason, "expired");
});

test("marketplace and direct-payment flows enforce the same sequential-provider rule", () => {
  const marketplace = source("services/marketplace/marketplace-service.js");
  const payment = source("services/wallet/lead-payment-service.js");
  const directAccess = source("services/lead/provider-direct-access-service.js");
  const enquiryModel = source("models/Enquiry.js");

  assert.match(marketplace, /providerSaleOutcome !== "not_confirmed"/);
  assert.match(marketplace, /assertNextProviderEligible/);
  assert.match(payment, /assertNextProviderEligible/);
  assert.match(payment, /marketplaceClosureReason: "provider_pending"/);
  assert.match(payment, /employeeDirectAccessConsumedSlot/);
  assert.match(payment, /markReadyForReassignment/);
  assert.match(directAccess, /assertNextProviderEligible/);
  assert.match(directAccess, /marketplaceClosureReason === "provider_pending"/);
  assert.match(enquiryModel, /"provider_pending"/);
});

test("a refunded earlier provider cannot reclaim a reassigned requirement", () => {
  const leadService = source("services/lead/lead-service.js");
  assert.match(leadService, /REFUNDED_OUTCOME_LOCKED/);
  assert.match(leadService, /LEAD_ALREADY_REASSIGNED/);
  assert.match(leadService, /unlockedAt: \{ \$gt: unlock\.unlockedAt \}/);
});

test("CRM-created unlock records are already unlocked in the provider portal", () => {
  const unlockModel = source("models/ProviderLeadUnlock.js");
  const leadPresenter = source("utils/lead.js");

  assert.match(unlockModel, /assignmentSource/);
  assert.match(unlockModel, /"crm_manual"/);
  assert.match(unlockModel, /assignedBy/);
  assert.match(unlockModel, /assignedAt/);
  assert.match(leadPresenter, /const unlocked = Boolean\(unlock\?\.providerLeadUnlockId\)/);
  assert.match(leadPresenter, /contactUnlocked: unlocked/);
  assert.match(leadPresenter, /customerMobile: enquiry\.mobile/);
});
