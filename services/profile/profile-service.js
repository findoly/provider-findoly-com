const { providerIdentity, presentProvider } = require("../../utils/provider");
const creditService = require("../billing/credit-service");

async function get(provider) {
  const syncedProvider = await creditService.syncCredits(providerIdentity(provider));
  return presentProvider(syncedProvider);
}

async function updateLocation() {
  throw Object.assign(
    new Error("Your service PIN code is managed by Findoly Admin. Contact support to request a change."),
    { status: 403, code: "CRM_MANAGED_LOCATION" },
  );
}

module.exports = { get, updateLocation };
