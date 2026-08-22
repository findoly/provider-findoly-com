const mongoose = require("mongoose");
const connectDatabase = require("../db/connection");
const CreditAllocation = require("../models/CreditAllocation");
const WalletTransaction = require("../models/WalletTransaction");

async function migrateNonExpiringCredits() {
  const now = new Date();
  const allocationResult = await CreditAllocation.updateMany(
    {
      source: "plan_purchase",
      status: "active",
      remainingMinorCredits: { $gt: 0 },
      expiresAt: { $ne: null },
    },
    { $set: { expiresAt: null, updatedAt: now } },
  );

  const transactionResult = await WalletTransaction.updateMany(
    {
      source: "plan_purchase",
      type: "credit",
      expiresAt: { $ne: null },
    },
    { $set: { expiresAt: null, updatedAt: now } },
  );

  return {
    allocationsMatched: Number(allocationResult.matchedCount || 0),
    allocationsUpdated: Number(allocationResult.modifiedCount || 0),
    transactionsMatched: Number(transactionResult.matchedCount || 0),
    transactionsUpdated: Number(transactionResult.modifiedCount || 0),
  };
}

async function main() {
  await connectDatabase();
  const summary = await migrateNonExpiringCredits();
  console.log(`Non-expiring credit migration: ${JSON.stringify(summary)}`);
  return summary;
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = {
  main,
  migrateNonExpiringCredits,
};
