require("dotenv").config();
const connectDatabase = require("../db/connection");
const Provider = require("../models/Provider");
const Enquiry = require("../models/Enquiry");
const ProviderLeadUnlock = require("../models/ProviderLeadUnlock");
const { providerIdentity, providerCategories } = require("../utils/provider");

async function run() {
  const reference = String(process.argv[2] || "").trim();
  if (!reference) throw new Error("Usage: node scripts/diagnose-provider.js <provider-id-or-mobile>");
  await connectDatabase();
  const provider = await Provider.findOne({
    $or: [{ providerId: reference }, { id: reference }, { mobile: reference }],
  }).lean();
  if (!provider) throw new Error("Provider not found");

  const providerId = providerIdentity(provider);
  const categorySlugs = providerCategories(provider);
  const now = new Date();
  const [marketplaceSample, unlockSample] = await Promise.all([
    Enquiry.find({
      marketplaceAvailable: true,
      marketplaceStatus: "published",
      categorySlug: { $in: categorySlugs },
      marketplacePublishedAt: { $lte: now },
      marketplaceExpiresAt: { $gt: now },
      remainingUnlocks: { $gt: 0 },
    })
      .select({ enquiryId: 1, categorySlug: 1, city: 1, remainingUnlocks: 1 })
      .sort({ marketplacePublishedAt: -1, _id: -1 })
      .limit(20)
      .lean(),
    ProviderLeadUnlock.find({ providerId })
      .select({ providerLeadUnlockId: 1, enquiryId: 1, unlockedAt: 1, providerSaleOutcome: 1 })
      .sort({ unlockedAt: -1, _id: -1 })
      .limit(20)
      .lean(),
  ]);

  console.log(JSON.stringify({
    providerId,
    categories: categorySlugs,
    serviceLocation: {
      pincode: provider.servicePincode || "",
      latitude: provider.serviceLatitude ?? null,
      longitude: provider.serviceLongitude ?? null,
    },
    marketplaceSample,
    unlockSample,
  }, null, 2));
  await require("mongoose").disconnect();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
