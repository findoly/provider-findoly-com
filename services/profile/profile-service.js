const { providerIdentity, presentProvider } = require("../../utils/provider");
const creditService = require("../billing/credit-service");

async function get(provider) {
  const syncedProvider = await creditService.syncCredits(
    providerIdentity(provider),
  );
  return presentProvider(syncedProvider);
}

module.exports = { get };
