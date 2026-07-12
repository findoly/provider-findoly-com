require("dotenv").config();

const mongoose = require("mongoose");
const connectDatabase = require("../db/connection");
const Provider = require("../models/Provider");
const LeadDistribution = require("../models/LeadDistribution");
const { normalizeMobile } = require("../utils/mobile");
const { creditsFromPaise } = require("../utils/credits");
const {
  ensureProviderEligible,
  providerIdentity,
} = require("../utils/provider");

async function run() {
  const mobile = normalizeMobile(process.argv[2]);
  if (mobile.length !== 10) {
    throw new Error("Pass a valid 10-digit mobile number");
  }

  await connectDatabase();
  const provider = await Provider.findOne({
    $or: [
      { normalizedMobile: mobile },
      { mobile },
      { mobile: `+91${mobile}` },
    ],
  }).lean();

  console.log("Database:", mongoose.connection.name);
  if (!provider) {
    console.log("Provider not found in the configured database.");
    return;
  }

  const providerId = providerIdentity(provider);
  let eligible = false;
  let eligibilityMessage = "Eligible";
  try {
    ensureProviderEligible(provider);
    eligible = true;
  } catch (error) {
    eligibilityMessage = error.message;
  }

  const [availableLeads, unlockedLeads] = await Promise.all([
    LeadDistribution.countDocuments({
      providerId,
      status: "offered",
      contactUnlocked: { $ne: true },
    }),
    LeadDistribution.countDocuments({
      providerId,
      contactUnlocked: true,
    }),
  ]);

  console.log({
    providerId,
    legacyId: provider.id || "",
    name: provider.name,
    businessName: provider.businessName,
    mobile: provider.mobile,
    normalizedMobile: provider.normalizedMobile,
    status: provider.status,
    portalAccessEnabled: provider.portalAccessEnabled,
    onboardingStage: provider.onboardingStage,
    availableCredits: creditsFromPaise(provider.walletBalancePaise),
    currentPlanCode: provider.currentPlanCode || "",
    currentBillingCycle: provider.currentBillingCycle || "",
    currentPlanExpiresAt: provider.currentPlanExpiresAt || null,
    categorySlugs: provider.categorySlugs,
    availableLeads,
    unlockedLeads,
    eligible,
    eligibilityMessage,
  });
}

run()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
