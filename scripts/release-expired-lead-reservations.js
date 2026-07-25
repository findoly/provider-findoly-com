const mongoose = require("mongoose");
const connectDatabase = require("../db/connection");
const leadPaymentService = require("../services/wallet/lead-payment-service");

function maximumBatches() {
  const configured = Number(process.env.LEAD_PAYMENT_CLEANUP_MAX_BATCHES || 20);
  return Number.isInteger(configured) && configured >= 1 && configured <= 100
    ? configured
    : 20;
}

async function main() {
  await connectDatabase();
  let scanned = 0;
  let released = 0;
  let failed = 0;
  const maxBatches = maximumBatches();

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await leadPaymentService.releaseExpiredReservations();
    scanned += Number(result.scanned || 0);
    released += Number(result.released || 0);
    failed += Number(result.failed || 0);
    if (Number(result.scanned || 0) < leadPaymentService.RELEASE_BATCH_SIZE) break;
  }

  const summary = { scanned, released, failed };
  console.log(`Lead reservation cleanup: ${JSON.stringify(summary)}`);
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
  maximumBatches,
  main,
};
