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
const billingHold = require("../config/billing-hold");

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
      { code: "growth-plus", name: "Growth", price: 299900, baseCredits: 3000, bonusPercent: 10, bonusCredits: 300, credits: 3300, leads: 66, expiry: null, recommended: true, bestValue: false },
      { code: "scale", name: "Scale", price: 499900, baseCredits: 5000, bonusPercent: 20, bonusCredits: 1000, credits: 6000, leads: 120, expiry: null, recommended: false, bestValue: false },
      { code: "pro", name: "Pro", price: 999900, baseCredits: 10000, bonusPercent: 30, bonusCredits: 3000, credits: 13000, leads: 260, expiry: null, recommended: false, bestValue: true },
    ],
  );

  for (const item of packages) {
    assert.equal(item.totalAmountPaise, item.finalPricePaise);
    assert.equal(item.gstIncluded, true);
    assert.equal(item.expiryLabel, "Never expires");
  }

  assert.equal(getCreditPackage("growth-plus").credits, 3300);
  assert.equal(getCreditPackage("pro").name, "Pro");
  assert.throws(
    () => getCreditPackage("monthly"),
    (error) => error.code === "CREDIT_PACKAGE_INVALID",
  );
});

test("legacy in-flight credit package codes retain their original fulfillment totals", () => {
  const visibleCodes = listCreditPackages().map((item) => item.code);
  assert.doesNotMatch(visibleCodes.join(","), /(^|,)growth(,|$)|(^|,)business(,|$)/);
  assert.equal(getCreditPackage("growth").credits, 3000);
  assert.equal(getCreditPackage("growth").bonusCredits, 0);
  assert.equal(getCreditPackage("business").credits, 10000);
  assert.equal(getCreditPackage("business").bonusCredits, 0);
});

test("plan page shows billing hold status and exposes no new checkout path", () => {
  const pricing = source("views/wallet/plans.ejs");
  const head = source("views/partials/head.ejs");

  assert.match(pricing, /Subscription on hold/);
  assert.match(pricing, /Current subscription/);
  assert.match(pricing, />On Hold</);
  assert.match(pricing, /existing plan access continues/i);
  assert.match(pricing, /matching leads\/bookings/i);
  assert.match(pricing, /Existing credits remain usable/i);
  assert.match(pricing, /New subscription payments, renewals and Lead Credit purchases are temporarily unavailable/);
  assert.match(pricing, /\/api\/wallet\?limit=1/);
  assert.match(head, /\/css\/lead-plans\.css/);
  assert.doesNotMatch(pricing, /checkout\.razorpay\.com/);
  assert.doesNotMatch(pricing, /\/api\/wallet\/credits\/order/);
  assert.doesNotMatch(pricing, /\/api\/wallet\/credits\/verify/);
  assert.doesNotMatch(pricing, /purchase\(creditPackage\)/);
});

test("Lead usage page removes wallet framing while keeping activity separate from pricing", () => {
  const activity = source("views/wallet/index.ejs");

  assert.match(activity, /Lead usage/);
  assert.match(activity, /Available Lead Credits/);
  assert.match(activity, /Lead usage history/);
  assert.match(activity, /Purchase history/);
  assert.match(activity, /href="\/plans">View plan status/);
  assert.match(activity, /Purchases temporarily on hold/);
  assert.match(activity, /transactionDescription\(transaction\)/);
  assert.match(activity, /paymentDescription\(order\)/);
  assert.match(activity, /transaction\.source === 'plan_purchase'/);
  assert.match(activity, /order\.purpose === 'plan_purchase'/);
  assert.doesNotMatch(activity, /Wallet &amp; activity/);
  assert.doesNotMatch(activity, /portal-billing-toggle|Choose your plan|Monthly|Yearly|purchase\(plan\)|Razorpay/);
});

test("provider navigation exposes plan and billing status without purchase wording", () => {
  const frontend = source("controllers/frontendController.js");
  const sidebar = source("views/partials/sidebar.ejs");
  const navbar = source("views/partials/navbar.ejs");

  assert.match(frontend, /"Plan & billing"/);
  assert.match(frontend, /"Lead usage"/);
  assert.match(sidebar, />Plan &amp; billing</);
  assert.match(sidebar, />Lead usage</);
  assert.doesNotMatch(sidebar, />Get Lead Credits</);
  assert.match(navbar, /Open Lead Credit activity/);
  assert.match(navbar, />Plan &amp; billing</);
  assert.doesNotMatch(navbar, />Get Lead Credits</);
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
  assert.match(controllerSource, /Subscription purchases are temporarily on hold/);
  assert.match(controllerSource, /Lead Credit purchases are temporarily on hold/);
  assert.doesNotMatch(controllerSource, /data: await walletService\.createPlanOrder/);
  assert.match(frontend, /"wallet\/plans"/);
  assert.match(frontend, /"wallet\/index"/);
  assert.match(sidebar, />Plan &amp; billing</);
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
  assert.match(forwarded?.message || "", /temporarily on hold/);
});

test("billing hold defaults on, is reversible, and blocks new credit orders before service execution", async () => {
  assert.equal(billingHold.enabled({}), true);
  assert.equal(billingHold.enabled({ PROVIDER_BILLING_HOLD: "false" }), false);
  assert.equal(
    billingHold.startedAt({}).toISOString(),
    billingHold.DEFAULT_BILLING_HOLD_STARTED_AT,
  );
  assert.equal(billingHold.state({}).status, "on_hold");

  let createCalls = 0;
  const controller = compile("controllers/walletController.js", {
    "../services/wallet/wallet-service": {
      async createCreditOrder() {
        createCalls += 1;
        throw new Error("must not be called");
      },
    },
  });

  let forwarded = null;
  await controller.createCreditOrder({}, {}, (error) => { forwarded = error; });
  assert.equal(createCalls, 0);
  assert.equal(forwarded?.status, 409);
  assert.equal(forwarded?.code, "BILLING_HOLD");
  assert.match(forwarded?.message || "", /Existing credits remain usable/);
});

test("held subscriptions preserve current plan state while direct lead payment remains available", () => {
  const walletService = source("services/wallet/wallet-service.js");
  const creditService = source("services/billing/credit-service.js");
  const leadView = source("views/lead/show.ejs");

  assert.match(walletService, /heldSubscriptionQuery/);
  assert.match(walletService, /billingHold\.startedAt\(\)/);
  assert.match(walletService, /status: \{ \$nin: \["cancelled", "failed"\] \}/);
  assert.match(walletService, /status: "on_hold"/);
  assert.match(walletService, /enabled: configured && !billingHold\.enabled\(\)/);
  assert.match(walletService, /billingHold\.assertPurchasesOpen\(\)/);
  assert.match(creditService, /!billingHold\.enabled\(\)/);
  assert.match(leadView, /Pay \$\{money\(directTotalPaise\)\} & unlock/);
  assert.match(leadView, /Credit purchases on hold/);
});
