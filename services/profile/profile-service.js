const Provider = require("../../models/Provider");
const { providerIdentity, providerQuery, presentProvider } = require("../../utils/provider");
const creditService = require("../billing/credit-service");
const { geocodePincode, normalizePincode } = require("../location/geocoding-service");
const { refreshProviderVisibility } = require("../marketplace/visibility-service");

async function get(provider) {
  const syncedProvider = await creditService.syncCredits(providerIdentity(provider));
  return presentProvider(syncedProvider);
}

async function updateLocation(provider, input = {}) {
  const providerId = providerIdentity(provider);
  const servicePincode = normalizePincode(input.servicePincode);
  const serviceAddress = String(input.serviceAddress || "").trim();
  if (serviceAddress.length > 500) {
    throw Object.assign(new Error("Full address must be 500 characters or less"), {
      status: 400,
      code: "ADDRESS_TOO_LONG",
    });
  }

  let location;
  const samePincode = servicePincode === String(provider.servicePincode || "")
    && Number.isFinite(Number(provider.serviceLatitude))
    && Number.isFinite(Number(provider.serviceLongitude));
  if (samePincode) {
    location = {
      pincode: servicePincode,
      latitude: Number(provider.serviceLatitude),
      longitude: Number(provider.serviceLongitude),
      locality: provider.serviceLocality || "",
      district: provider.serviceDistrict || "",
      city: provider.city || "",
      state: provider.serviceState || provider.state || "",
      country: provider.serviceCountry || "India",
      source: provider.serviceLocationSource || "google_geocoding",
      verifiedAt: provider.serviceLocationVerifiedAt || new Date(),
    };
  } else {
    location = await geocodePincode(servicePincode);
  }

  const now = new Date();
  const update = {
    servicePincode,
    serviceAddress,
    serviceLatitude: Number(location.latitude),
    serviceLongitude: Number(location.longitude),
    serviceLocality: location.locality || "",
    serviceDistrict: location.district || "",
    serviceState: location.state || "",
    serviceCountry: location.country || "India",
    serviceLocationVerifiedAt: location.verifiedAt || now,
    serviceLocationSource: location.source || "google_geocoding",
    city: location.city || location.locality || provider.city || "",
    state: location.state || provider.state || "",
    updatedAt: now,
  };
  await Provider.updateOne(providerQuery(providerId), { $set: update });
  const refreshed = await Provider.findOne(providerQuery(providerId)).lean();
  await refreshProviderVisibility(refreshed, { force: true });
  return presentProvider(refreshed);
}

module.exports = { get, updateLocation };
