const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("provider portal reads shared credit allocations and wallet transactions", () => {
  const allocationModel = source("models/CreditAllocation.js");
  const transactionModel = source("models/WalletTransaction.js");
  const walletService = source("services/wallet/wallet-service.js");

  assert.match(allocationModel, /collection:\s*"creditallocations"/);
  assert.match(transactionModel, /collection:\s*"wallettransactions"/);
  assert.match(walletService, /transaction\.description/);
  assert.match(walletService, /creditsFromPaise\(transaction\.amountPaise\)/);
});

test("provider credit activity preserves Admin-authored transaction descriptions", () => {
  const view = source("views/wallet/index.ejs");
  const walletService = source("services/wallet/wallet-service.js");

  assert.match(view, /account adjustments/);
  assert.match(view, /transaction\.description/);
  assert.match(walletService, /query: \{ providerId \}/);
  assert.match(walletService, /transaction\.description/);
});
