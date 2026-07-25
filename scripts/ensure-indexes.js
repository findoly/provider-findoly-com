"use strict";
require("dotenv").config();
const mongoose = require("mongoose");
const connectDatabase = require("../db/connection");
const Enquiry = require("../models/Enquiry");
const ProviderLeadUnlock = require("../models/ProviderLeadUnlock");
const PaymentOrder = require("../models/PaymentOrder");
const WalletTransaction = require("../models/WalletTransaction");
const ProviderSubscription = require("../models/ProviderSubscription");

function indexedModels() {
  return [
    Enquiry,
    ProviderLeadUnlock,
    PaymentOrder,
    WalletTransaction,
    ProviderSubscription,
  ];
}

async function run() {
  await connectDatabase();
  for (const model of indexedModels()) {
    await model.createIndexes();
    console.log(`Indexes ensured: ${model.modelName}`);
  }
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
