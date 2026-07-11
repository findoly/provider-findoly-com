require("dotenv").config();

const mongoose = require("mongoose");
const connectDatabase = require("../db/connection");
const Provider = require("../models/Provider");
const Enquiry = require("../models/Enquiry");
const LeadDistribution = require("../models/LeadDistribution");
const WalletTransaction = require("../models/WalletTransaction");
const PaymentOrder = require("../models/PaymentOrder");

async function run() {
  await connectDatabase();
  const models = [
    Provider,
    Enquiry,
    LeadDistribution,
    WalletTransaction,
    PaymentOrder,
  ];

  for (const model of models) {
    await model.createIndexes();
    console.log(`Indexes ensured: ${model.collection.collectionName}`);
  }
}

run()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
