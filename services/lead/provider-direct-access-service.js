"use strict";

const Enquiry = require("../../models/Enquiry");
const { providerIdentity } = require("../../utils/provider");
const marketplaceService = require("../marketplace/marketplace-service");
const directAccessToken = require("./provider-direct-access-token");

function unavailableError() {
  return Object.assign(new Error("This employee-shared lead is no longer available"), {
    status: 410,
    code: "DIRECT_LEAD_NOT_AVAILABLE",
  });
}

function verify(provider, enquiryId, token, options = {}) {
  const normalized = String(token || "").trim();
  if (!normalized) return null;
  return directAccessToken.verify(normalized, {
    providerId: providerIdentity(provider),
    enquiryId: marketplaceService.publicId(enquiryId),
    now: options.now || new Date(),
  });
}

function lifecycleAllowsDirectAccess(provider, lead, now = new Date()) {
  if (!lead || lead.status !== "approved" || lead.isActive === false) return false;
  if (!lead.marketplacePublishedAt || new Date(lead.marketplacePublishedAt) > now) return false;
  if (!lead.marketplaceExpiresAt || new Date(lead.marketplaceExpiresAt) <= now) return false;

  const visibleAt = marketplaceService.visibilityFor(provider, lead).marketplaceVisibleAt;
  if (!visibleAt || visibleAt > now) return false;
  if (marketplaceService.isVisibleNow(provider, lead, now)) return true;

  const noSlots = Number(lead.remainingUnlocks || 0) <= 0;
  if (!noSlots) return false;
  if (
    lead.marketplaceStatus === "closed"
    && lead.marketplaceAvailable === false
    && lead.marketplaceClosureReason === "unlock_limit"
  ) {
    return true;
  }

  // A concurrent unlock can move the counter to zero immediately before the
  // normal close update lands. The direct grant may bridge that brief state,
  // but it still cannot override any non-limit closure reason.
  return lead.marketplaceStatus === "published"
    && lead.marketplaceClosureReason !== "status_change"
    && lead.marketplaceClosureReason !== "invalid"
    && lead.marketplaceClosureReason !== "deactivated"
    && lead.marketplaceClosureReason !== "expired";
}

async function load(provider, enquiryId, options = {}) {
  const id = marketplaceService.publicId(enquiryId);
  let query = Enquiry.findOne({ enquiryId: id });
  if (options.session) query = query.session(options.session);
  const lead = await query;
  if (!lead) {
    throw Object.assign(new Error("Lead not found"), { status: 404, code: "LEAD_NOT_FOUND" });
  }

  marketplaceService.assertCategoryMatch(provider, lead);
  if (!lifecycleAllowsDirectAccess(provider, lead, options.now || new Date())) {
    throw unavailableError();
  }
  return lead;
}

module.exports = {
  verify,
  lifecycleAllowsDirectAccess,
  load,
};
