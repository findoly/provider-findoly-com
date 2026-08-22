const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  getCreditPackage,
  listCreditPackages,
  MINIMUM_LEAD_CREDITS,
} = require("../config/plans");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("provider credit packages use final prices, non-expiring credits and 50-credit lead estimates", () => {
  const packages = listCreditPackages();
  assert.equal(packages.length, 3);
  assert.equal(MINIMUM_LEAD_CREDITS, 50);

  assert.deepEqual(
    packages.map((item) => ({
      code: item.code,
      price: item.finalPricePaise,
      credits: item.credits,
      leads: item.estimatedLeads,
      expiry: item.expiresAt,
    })),
    [
      { code: "starter", price: 99900, credits: 1000, leads: 20, expiry: null },
      { code: "growth", price: 299900, credits: 3000, leads: 60, expiry: null },
      { code: "business", price: 999900, credits: 10000, leads: 200, expiry: null },
    ],
  );

  for (const item of packages) {
    assert.equal(item.totalAmountPaise, item.finalPricePaise);
    assert.equal(item.gstIncluded, true);
    assert.equal(item.expiryLabel, "Never expires");
  }

  assert.equal(getCreditPackage("growth").credits, 3000);
  assert.throws(
    () => getCreditPackage("monthly"),
    (error) => error.code === "CREDIT_PACKAGE_INVALID",
  );
});

test("pricing page is focused on buying credits without subscription controls", () => {
  const pricing = source("views/wallet/plans.ejs");

  assert.match(pricing, /Buy credits/);
  assert.match(pricing, /Lead unlocks start from 50 credits/);
  assert.match(pricing, /credits never expire/i);
  assert.match(pricing, /Up to \$\{Number\(creditPackage\.estimatedLeads/);
  assert.match(pricing, /\/api\/wallet\/credits\/order/);
  assert.match(pricing, /\/api\/wallet\/credits\/verify/);
  assert.match(pricing, /purpose: 'credit_purchase'/);
  assert.doesNotMatch(pricing, /Monthly|Yearly|\/ month|\/ year|billingCycle|Renewal scheduled|Choose your plan/);
  assert.doesNotMatch(pricing, /GST/);
});

test("wallet page keeps activity separate from credit pricing", () => {
  const wallet = source("views/wallet/index.ejs");

  assert.match(wallet, /Wallet &amp; activity/);
  assert.match(wallet, /Available credits/);
  assert.match(wallet, /Credit activity/);
  assert.match(wallet, /Payment history/);
  assert.match(wallet, /href="\/plans">Buy credits/);
  assert.doesNotMatch(wallet, /portal-billing-toggle|Choose your plan|Monthly|Yearly|purchase\(plan\)|Razorpay/);
});

test("new credit checkout does not create subscriptions and legacy plan fulfillment remains available", () => {
  const service = source("services/wallet/wallet-service.js");
  const creditFlow = service.match(/async function fulfillCreditOrder[\s\S]*?async function fulfillPlanOrder/)?.[0] || "";

  assert.match(service, /purpose: "credit_purchase"/);
  assert.match(service, /source: "credit_purchase"/);
  assert.match(service, /idempotencyKey: `credit-purchase:/);
  assert.match(creditFlow, /expiresAt: null/);
  assert.doesNotMatch(creditFlow, /ProviderSubscription\.create/);
  assert.doesNotMatch(creditFlow, /syncProviderPlanState/);
  assert.match(service, /async function fulfillPlanOrder/);
  assert.match(service, /paymentOrder\.purpose === "plan_purchase"/);
});

test("existing purchased credit allocations are converted to non-expiring balances", () => {
  const creditService = source("services/billing/credit-service.js");
  const migration = source("scripts/migrate-non-expiring-credits.js");

  assert.match(creditService, /makePurchasedCreditsNonExpiring/);
  assert.match(creditService, /source: "plan_purchase"[\s\S]*expiresAt: \{ \$ne: null \}/);
  assert.match(creditService, /\$set: \{ expiresAt: null/);
  assert.match(migration, /source: "plan_purchase"/);
  assert.match(migration, /expiresAt: null/);
});

test("credit routes are separate while legacy plan routes remain available for in-flight orders", () => {
  const routes = source("routes/wallet.js");
  const frontend = source("controllers/frontendController.js");
  const sidebar = source("views/partials/sidebar.ejs");

  assert.match(routes, /"\/credits\/order"/);
  assert.match(routes, /"\/credits\/cancel"/);
  assert.match(routes, /"\/credits\/verify"/);
  assert.match(routes, /"\/plan\/order"/);
  assert.match(frontend, /"wallet\/plans"/);
  assert.match(frontend, /"wallet\/index"/);
  assert.match(sidebar, />Buy credits</);
  assert.match(sidebar, />Wallet &amp; activity</);
});
