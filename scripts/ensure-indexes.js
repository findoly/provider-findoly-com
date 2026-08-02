"use strict";

require("dotenv").config();
const mongoose = require("mongoose");
const connectDatabase = require("../db/connection");
const { verifySharedIndexes } = require("../db/shared-contract");
const Provider = require("../models/Provider");
const ProviderJoinRequest = require("../models/ProviderJoinRequest");
const ContactIdentity = require("../models/ContactIdentity");
const Enquiry = require("../models/Enquiry");
const ProviderLeadUnlock = require("../models/ProviderLeadUnlock");
const ProviderCrmSyncEvent = require("../models/ProviderCrmSyncEvent");
const PaymentOrder = require("../models/PaymentOrder");
const WalletTransaction = require("../models/WalletTransaction");
const ProviderSubscription = require("../models/ProviderSubscription");
const ProviderOtpRateLimit = require("../models/ProviderOtpRateLimit");

function indexedModels() {
  return [
    Provider,
    ProviderJoinRequest,
    ContactIdentity,
    Enquiry,
    ProviderLeadUnlock,
    ProviderCrmSyncEvent,
    PaymentOrder,
    WalletTransaction,
    ProviderSubscription,
    ProviderOtpRateLimit,
  ];
}

async function run({ verifyOnly = process.argv.includes("--verify-only") } = {}) {
  const connection = await connectDatabase({ verifySharedIndexes: false });
  if (!verifyOnly) {
    for (const model of indexedModels()) {
      await model.createIndexes();
      console.log(`Indexes ensured: ${model.modelName}`);
    }
  }
  const result = await verifySharedIndexes(connection);
  console.log(`Shared indexes verified: ${result.verified}`);
}

if (require.main === module) {
  run()
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    })
    .finally(async () => mongoose.disconnect().catch(() => {}));
}

module.exports = {
  indexedModels,
  run,
};
