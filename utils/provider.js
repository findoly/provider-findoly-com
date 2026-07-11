const { creditsFromPaise } = require("./credits");

function providerIdentity(provider = {}) {
  return String(provider.providerId || provider.id || "").trim();
}

function providerCategories(provider = {}) {
  return [...new Set(
    (Array.isArray(provider.categorySlugs) ? provider.categorySlugs : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
}

function providerQuery(providerId) {
  const value = String(providerId || "").trim();
  return { $or: [{ providerId: value }, { id: value }] };
}

function presentProvider(provider = {}) {
  const providerId = providerIdentity(provider);
  return {
    providerId,
    name: provider.name || "",
    businessName: provider.businessName || "",
    mobile: provider.mobile || "",
    email: provider.email || "",
    status: provider.status || "",
    onboardingStage: provider.onboardingStage || "new",
    categorySlugs: providerCategories(provider),
    skills: Array.isArray(provider.skills) ? provider.skills : [],
    city: provider.city || "",
    state: provider.state || "",
    serviceAreas: Array.isArray(provider.serviceAreas)
      ? provider.serviceAreas
      : [],
    availability: provider.availability || "",
    rating: Number(provider.rating || 0),
    documentsVerified: provider.documentsVerified === true,
    portalAccessEnabled: provider.portalAccessEnabled !== false,
    walletBalancePaise: Number(provider.walletBalancePaise || 0),
    walletCredits: creditsFromPaise(provider.walletBalancePaise),
    walletCurrency: provider.walletCurrency || "INR",
    walletUpdatedAt: provider.walletUpdatedAt || null,
    lastLoginAt: provider.lastLoginAt || null,
    updatedAt: provider.updatedAt || null,
  };
}

function ensureProviderEligible(provider) {
  if (!provider) {
    throw Object.assign(new Error("Provider account not found"), {
      status: 401,
      code: "PROVIDER_NOT_FOUND",
    });
  }

  if (String(provider.status || "").toLowerCase() !== "active") {
    throw Object.assign(new Error("Provider account is inactive"), {
      status: 403,
      code: "PROVIDER_INACTIVE",
    });
  }

  if (provider.portalAccessEnabled === false) {
    throw Object.assign(new Error("Provider portal access is disabled"), {
      status: 403,
      code: "PORTAL_ACCESS_DISABLED",
    });
  }

  const providerId = providerIdentity(provider);
  if (!providerId) {
    throw Object.assign(
      new Error("Provider record is missing its provider identifier"),
      { status: 409, code: "PROVIDER_ID_MISSING" },
    );
  }

  return { ...provider, providerId };
}

module.exports = {
  providerIdentity,
  providerCategories,
  providerQuery,
  presentProvider,
  ensureProviderEligible,
};
