"use strict";

const Enquiry = require("../../models/Enquiry");
const ProviderLeadUnlock = require("../../models/ProviderLeadUnlock");

function blockingQuery(enquiryId, excludeProviderId = "") {
  const query = {
    enquiryId: String(enquiryId || "").trim(),
    providerSaleOutcome: { $ne: "not_confirmed" },
  };
  if (excludeProviderId) query.providerId = { $ne: String(excludeProviderId) };
  return query;
}

async function findBlockingUnlock(enquiryId, excludeProviderId = "", session = null) {
  let query = ProviderLeadUnlock.findOne(blockingQuery(enquiryId, excludeProviderId))
    .select({
      providerLeadUnlockId: 1,
      providerId: 1,
      providerSaleOutcome: 1,
      unlockedAt: 1,
    });
  if (session) query = query.session(session);
  return query.lean();
}

async function assertNextProviderEligible(enquiryId, providerId = "", session = null) {
  const blocker = await findBlockingUnlock(enquiryId, providerId, session);
  if (blocker) {
    throw Object.assign(
      new Error("This requirement is still assigned to another provider. It can be unlocked again only after every earlier provider is marked Not Confirmed."),
      {
        status: 409,
        code: "PREVIOUS_PROVIDER_NOT_CLOSED",
        blockingProviderId: blocker.providerId || "",
        blockingProviderLeadUnlockId: blocker.providerLeadUnlockId || "",
      },
    );
  }
  return true;
}

async function reopenIfAllNotConfirmed(enquiryId, session = null, now = new Date()) {
  const blocker = await findBlockingUnlock(enquiryId, "", session);
  if (blocker) {
    return { reopened: false, blocked: true, blocker };
  }

  let query = Enquiry.findOne({ enquiryId: String(enquiryId || "").trim() });
  if (session) query = query.session(session);
  const lead = await query;
  if (!lead) return { reopened: false, blocked: false, reason: "lead_missing" };

  const eligible =
    lead.status === "approved"
    && lead.isActive !== false
    && lead.marketplacePublishedAt
    && new Date(lead.marketplacePublishedAt) <= now
    && lead.marketplaceExpiresAt
    && new Date(lead.marketplaceExpiresAt) > now
    && Number(lead.reservedUnlockCount || 0) === 0;

  if (!eligible) {
    return { reopened: false, blocked: false, reason: "lead_not_eligible" };
  }

  if (Number(lead.remainingUnlocks || 0) <= 0) {
    lead.marketplaceAvailable = false;
    lead.marketplaceStatus = "closed";
    lead.marketplaceClosureReason = "unlock_limit";
    lead.updatedAt = now;
    await lead.save({ session });
    return { reopened: false, blocked: false, reason: "unlock_limit" };
  }

  lead.marketplaceAvailable = true;
  lead.marketplaceStatus = "published";
  lead.marketplaceClosureReason = "";
  lead.updatedAt = now;
  await lead.save({ session });
  return { reopened: true, blocked: false, lead: lead.toObject() };
}

module.exports = {
  blockingQuery,
  findBlockingUnlock,
  assertNextProviderEligible,
  reopenIfAllNotConfirmed,
};
