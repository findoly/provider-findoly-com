const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Module = require("node:module");

const {
  getCreditPackage,
  listCreditPackages,
  MINIMUM_LEAD_CREDITS,
} = require("../config/plans");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function compile(relativePath, mocks = {}) {
  const filename = path.join(__dirname, "..", relativePath);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = (request) => (
    Object.prototype.hasOwnProperty.call(mocks, request)
      ? mocks[request]
      : Module.createRequire(filename)(request)
  );
  loaded._compile(fs.readFileSync(filename, "utf8"), filename);
  return loaded.exports;
}

test("provider Lead Packs use final prices, bonuses, non-expiring credits and 50-credit lead estimates", () => {
  const packages = listCreditPackages();
  assert.equal(packages.length, 4);
  assert.equal(MINIMUM_LEAD_CREDITS, 50);

  assert.deepEqual(
    packages.map((item) => ({
      code: item.code,
      name: item.name,
      price: item.finalPricePaise,
      baseCredits: item.baseCredits,
      bonusPercent: item.bonusPercent,
      bonusCredits: item.bonusCredits,
      credits: item.credits,
      leads: item.estimatedLeads,
      expiry: item.expiresAt,
      recommended: item.recommended,
      bestValue: item.bestValue,
    })),
    [
      { code: "starter", name: "Starter", price: 99900, baseCredits: 1000, bonusPercent: 0, bonusCredits: 0, credits: 1000, leads: 20, expiry: null, recommended: false, bestValue: false },
      { code: "growth", name: "Growth", price: 299900, baseCredits: 3000, bonusPercent: 10, bonusCredits: 300, credits: 3300, leads: 66, expiry: null, recommended: true, bestValue: false },
      { code: "scale", name: "Scale", price: 499900, baseCredits: 5000, bonusPercent: 20, bonusCredits: 1000, credits: 6000, leads: 120, expiry: null, recommended: false, bestValue: false },
      { code: "business", name: "Pro", price: 999900, baseCredits: 10000, bonusPercent: 30, bonusCredits: 3000, credits: 13000, leads: 260, expiry: null, recommended: false, bestValue: true },
    ],
  );

  for (const item of packages) {
    assert.equal(item.totalAmountPaise, item.finalPricePaise);
    assert.equal(item.gstIncluded, true);
    assert.equal(item.expiryLabel, "Never expires");
  }

  assert.equal(getCreditPackage("growth").credits, 3300);
  assert.equal(getCreditPackage("business").name, "Pro");
  assert.throws(
    () => getCreditPackage("monthly"),
    (error) => error.code === "CREDIT_PACKAGE_INVALID",
  );
});

test("Lead Pack pricing page is focused, lead-oriented and has horizontal mobile comparison", () => {
  const pricing = source("views/wallet/plans.ejs");
  const pricingCss = source("public/css/lead-plans.css");

  assert.match(pricing, /Get more leads/);
  assert.match(pricing, /Choose a Lead Pack/);
  assert.match(pricing, /Available Lead Credits/);
  assert.match(pricing, /Most Popular/);
  assert.match(pricing, /Best Value/);
  assert.match(pricing, /bonus/);
  assert.match(pricing, /Lead Credits never expire/i);
  assert.match(pricing, /Up to \$\{Number\(creditPackage\.estimatedLeads/);
  assert.match(pricing, /Swipe to compare/);
  assert.match(pricing, /\/api\/wallet\/credits\/order/);
  assert.match(pricing, /\/api\/wallet\/credits\/verify/);
  assert.match(pricing, /purpose: 'credit_purchase'/);
  assert.match(pricing, /\/css\/lead-plans\.css/);
  assert.doesNotMatch(pricing, /Wallet &amp; activity/);
  assert.doesNotMatch(pricing, /Monthly|Yearly|\/ month|\/ year|billingCycle|Renewal scheduled|Choose your plan/);
  assert.doesNotMatch(pricing, /GST/);

  assert.match(pricingCss, /overflow-x:\s*auto/);
  assert.match(pricingCss, /scroll-snap-type:\s*x mandatory/);
  assert.match(pricingCss, /scroll-snap-align:\s*start/);
  assert.match(pricingCss, /flex:\s*0 0 min\(84vw, 21rem\)/);
});

test("Lead usage page removes wallet framing while keeping activity separate from pricing", () => {
  const activity = source("views/wallet/index.ejs");

  assert.match(activity, /Lead usage/);
  assert.match(activity, /Available Lead Credits/);
  assert.match(activity, /Lead usage history/);
  assert.match(activity, /Purchase history/);
  assert.match(activity, /href="\/plans">Get Lead Credits/);
  assert.match(activity, /transactionDescription\(transaction\)/);
  assert.match(activity, /paymentDescription\(order\)/);
  assert.match(activity, /transaction\.source === 'plan_purchase'/);
  assert.match(activity, /order\.purpose === 'plan_purchase'/);
  assert.doesNotMatch(activity, /Wallet &amp; activity/);
  assert.doesNotMatch(activity, /portal-billing-toggle|Choose your plan|Monthly|Yearly|purchase\(plan\)|Razorpay/);
});

test("provider navigation uses Lead Credits and Lead usage instead of wallet wording", () => {
  const frontend = source("controllers/frontendController.js");
  const sidebar = source("views/partials/sidebar.ejs");
  const navbar = source("views/partials/navbar.ejs");

  assert.match(frontend, /"Get Lead Credits"/);
  assert.match(frontend, /"Lead usage"/);
  assert.match(sidebar, />Get Lead Credits</);
  assert.match(sidebar, />Lead usage</);
  assert.doesNotMatch(sidebar, />Wallet &amp; activity</);
  assert.match(navbar, /Open Lead Credit activity/);
  assert.match(navbar, />Get Lead Credits</);
  assert.doesNotMatch(navbar, /Open wallet and credit activity/);
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

test("insufficient Lead Credits keep the existing secure direct-payment unlock fallback", () => {
  const leadView = source("views/lead/show.ejs");
  const leadPayment = source("services/wallet/lead-payment-service.js");

  assert.match(leadView, /x-if="!hasEnoughBalance"/);
  assert.match(leadView, /@click="payAndUnlock\(\)"/);
  assert.match(leadView, /Pay \$\{money\(directTotalPaise\)\} & unlock/);
  assert.match(leadView, /Direct payment unlocks only this lead/);
  assert.match(leadView, /href="\/plans"/);
  assert.match(leadPayment, /walletBalancePaise \|\| 0\) >= costMinorCredits/);
  assert.match(leadPayment, /code: "CREDITS_AVAILABLE"/);
  assert.match(leadPayment, /directPaymentQuote\(costMinorCredits\)/);
});

test("credit routes are separate and new legacy subscription orders are blocked", () => {
  const routes = source("routes/wallet.js");
  const controllerSource = source("controllers/walletController.js");
  const frontend = source("controllers/frontendController.js");
  const sidebar = source("views/partials/sidebar.ejs");

  assert.match(routes, /"\/credits\/order"/);
  assert.match(routes, /"\/credits\/cancel"/);
  assert.match(routes, /"\/credits\/verify"/);
  assert.match(routes, /"\/plan\/order"/);
  assert.match(controllerSource, /PLAN_PURCHASE_DISABLED/);
  assert.match(controllerSource, /Subscription purchases are no longer available/);
  assert.doesNotMatch(controllerSource, /data: await walletService\.createPlanOrder/);
  assert.match(frontend, /"wallet\/plans"/);
  assert.match(frontend, /"wallet\/index"/);
  assert.match(sidebar, />Get Lead Credits</);
  assert.match(sidebar, />Lead usage</);
});

test("legacy plan order creation is rejected at runtime without calling the old service", () => {
  let createCalls = 0;
  const controller = compile("controllers/walletController.js", {
    "../services/wallet/wallet-service": {
      async createPlanOrder() {
        createCalls += 1;
        throw new Error("must not be called");
      },
    },
  });
  let forwarded = null;
  controller.createPlanOrder({}, {}, (error) => { forwarded = error; });
  assert.equal(createCalls, 0);
  assert.equal(forwarded?.status, 409);
  assert.equal(forwarded?.code, "PLAN_PURCHASE_DISABLED");
  assert.match(forwarded?.message || "", /Choose a credit package/);
});
