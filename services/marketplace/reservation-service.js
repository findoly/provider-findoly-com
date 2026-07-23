const Enquiry = require("../../models/Enquiry");
const LeadDistribution = require("../../models/LeadDistribution");

function enquiryQuery(enquiryId) {
  return { $or: [{ enquiryId }, { id: enquiryId }] };
}

async function decrementPending(enquiryId, amount = 1, session = null) {
  const count = Math.max(0, Math.floor(Number(amount || 0)));
  if (!enquiryId || !count) return;
  await Enquiry.updateOne(
    enquiryQuery(enquiryId),
    [
      {
        $set: {
          pendingUnlockCount: {
            $max: [
              0,
              { $subtract: [{ $ifNull: ["$pendingUnlockCount", 0] }, count] },
            ],
          },
          updatedAt: new Date(),
        },
      },
    ],
    session ? { session } : {},
  );
}

async function releaseExpiredUnlockReservations({
  enquiryId = "",
  limit = 200,
  session = null,
} = {}) {
  const now = new Date();
  const query = {
    contactUnlocked: { $ne: true },
    directPaymentPendingOrderId: { $nin: ["", null] },
    directPaymentPendingUntil: { $ne: null, $lte: now },
  };
  if (enquiryId) query.enquiryId = String(enquiryId);

  let finder = LeadDistribution.find(query)
    .select({ leadDistributionId: 1, enquiryId: 1, directPaymentPendingOrderId: 1 })
    .sort({ directPaymentPendingUntil: 1, _id: 1 })
    .limit(Math.min(1000, Math.max(1, Number(limit || 200))));
  if (session) finder = finder.session(session);
  const rows = await finder.lean();

  const releasedByEnquiry = new Map();
  for (const row of rows) {
    const result = await LeadDistribution.updateOne(
      {
        leadDistributionId: row.leadDistributionId,
        contactUnlocked: { $ne: true },
        directPaymentPendingOrderId: row.directPaymentPendingOrderId,
        directPaymentPendingUntil: { $lte: now },
      },
      {
        $set: {
          directPaymentPendingOrderId: "",
          directPaymentPendingUntil: null,
          updatedAt: now,
        },
      },
      session ? { session } : {},
    );
    if (!result.modifiedCount) continue;
    const reference = String(row.enquiryId || "").trim();
    if (reference) {
      releasedByEnquiry.set(reference, (releasedByEnquiry.get(reference) || 0) + 1);
    }
  }

  for (const [reference, count] of releasedByEnquiry) {
    await decrementPending(reference, count, session);
  }

  return {
    released: [...releasedByEnquiry.values()].reduce((sum, count) => sum + count, 0),
    enquiries: releasedByEnquiry.size,
  };
}

module.exports = {
  decrementPending,
  releaseExpiredUnlockReservations,
};
