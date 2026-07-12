const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { createSessionToken } = require("../utils/session");
const { presentLead } = require("../utils/lead");

process.env.SKIP_DB = "true";
process.env.JWT_SECRET = "architecture-test-secret";
process.env.AUTH_COOKIE_NAME = "provider_auth";

const app = require("../app");
const Provider = require("../models/Provider");
const Enquiry = require("../models/Enquiry");
const LeadDistribution = require("../models/LeadDistribution");
const CreditAllocation = require("../models/CreditAllocation");
const ProviderSubscription = require("../models/ProviderSubscription");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function allViewFiles() {
  const root = path.join(__dirname, "..", "views");
  const files = [];
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const target = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name.endsWith(".ejs")) files.push(target);
    }
  }
  walk(root);
  return files;
}

test("provider portal separates frontend page routes from JSON API routes", async () => {
  assert.equal(typeof app, "function");
  assert.ok(require("../routes/frontend"));
  assert.ok(require("../routes/main"));

  const response = await request(app).get("/api/profile");
  assert.equal(response.status, 401);
  assert.equal(response.type, "application/json");
  assert.equal(response.body.success, false);
});

test("frontend controller renders metadata only and does not import data layers", () => {
  const controller = source("controllers/frontendController.js");
  assert.doesNotMatch(controller, /models\//);
  assert.doesNotMatch(controller, /services\//);
  assert.doesNotMatch(controller, /req\.params|req\.query/);
  assert.match(controller, /res\.render\(view, \{ title, subtitle \}\)/);
});

test("EJS pages use only structural partials and fetch records from API with Alpine", () => {
  const allowed = new Set(["head", "navbar", "sidebar", "footer", "scripts"]);
  for (const file of allViewFiles()) {
    const content = fs.readFileSync(file, "utf8");
    for (const match of content.matchAll(/include\(['"]([^'"]+)['"]\)/g)) {
      const name = path.basename(match[1]);
      assert.ok(
        allowed.has(name),
        `${file} includes non-structural partial ${name}`,
      );
    }
  }

  assert.match(
    source("views/dashboard/index.ejs"),
    /apiFetch\('\/api\/dashboard/,
  );
  assert.match(source("views/lead/index.ejs"), /apiFetch\('\/api\/lead/);
  assert.match(source("views/profile/index.ejs"), /apiFetch\('\/api\/profile/);
  assert.match(source("views/wallet/index.ejs"), /apiFetch\('\/api\/wallet/);
});

test("models keep MongoDB _id and add plain 32-character collection IDs", () => {
  const provider = new Provider({ name: "Test Provider" });
  const enquiry = new Enquiry({ categorySlug: "painting" });
  const distribution = new LeadDistribution({
    enquiryId: enquiry.enquiryId,
    providerId: provider.providerId,
    leadPricePaise: 10000,
  });
  const allocation = new CreditAllocation({
    providerId: provider.providerId,
    source: "plan_purchase",
    referenceId: "test-plan",
    amountMinorCredits: 100000,
    remainingMinorCredits: 100000,
  });
  const subscription = new ProviderSubscription({
    providerId: provider.providerId,
    paymentOrderId: "payment-order-test",
    planCode: "starter",
    planName: "Starter",
    billingCycle: "monthly",
    startsAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    listedPricePaise: 99900,
    subtotalPaise: 99900,
    gstAmountPaise: 17982,
    totalAmountPaise: 117882,
    baseCredits: 1000,
    bonusCredits: 0,
    totalCredits: 1000,
  });

  for (const value of [
    provider.providerId,
    enquiry.enquiryId,
    distribution.leadDistributionId,
    allocation.creditAllocationId,
    subscription.providerSubscriptionId,
  ]) {
    assert.match(value, /^[a-f0-9]{32}$/);
  }

  assert.ok(provider._id);
  assert.equal(Provider.schema.path("id"), undefined);
  assert.equal(Enquiry.schema.path("id"), undefined);
  assert.equal(LeadDistribution.schema.path("id"), undefined);
  assert.equal(CreditAllocation.schema.path("id"), undefined);
  assert.equal(ProviderSubscription.schema.path("id"), undefined);
});

test("plan and direct-unlock payments use verified Razorpay orders without arbitrary top-ups", async () => {
  const walletRoutes = source("routes/wallet.js");
  const leadRoutes = source("routes/lead.js");
  const walletService = source("services/wallet/wallet-service.js");
  const walletView = source("views/wallet/index.ejs");
  const leadView = source("views/lead/show.ejs");

  assert.match(walletRoutes, /["']\/plan\/order["']/);
  assert.match(walletRoutes, /["']\/verify["']/);
  assert.doesNotMatch(walletRoutes, /post\(\s*["']\/order["']/);
  assert.match(leadRoutes, /direct-order/);
  assert.match(leadRoutes, /direct-verify/);
  assert.match(walletService, /orders\.create/);
  assert.match(walletService, /payments\.fetch/);
  assert.match(walletService, /createHmac\(["']sha256["']/);
  assert.match(walletService, /purpose:\s*["']plan_purchase["']/);
  assert.match(walletService, /purpose:\s*["']lead_unlock["']/);
  assert.match(walletView, /checkout\.razorpay\.com\/v1\/checkout\.js/);
  assert.match(walletView, /\/api\/wallet\/plan\/order/);
  assert.match(walletView, /\/api\/wallet\/verify/);
  assert.match(leadView, /\/direct-order/);
  assert.match(leadView, /\/direct-verify/);
  assert.doesNotMatch(walletView, /Amount in rupees|Buy credits|demo-topup/);

  const providerId = "a".repeat(32);
  const originalFindOne = Provider.findOne;
  let lookupCount = 0;
  Provider.findOne = () => ({
    lean: async () => {
      lookupCount += 1;
      return {
        providerId,
        name: "Test Provider",
        status: "active",
        portalAccessEnabled: true,
        categorySlugs: ["painting"],
        walletBalancePaise: 0,
      };
    },
  });

  try {
    const token = createSessionToken(providerId);
    const response = await request(app)
      .get("/plans")
      .set("Cookie", [`provider_auth=${token}`]);

    assert.equal(response.status, 200);
    assert.equal(lookupCount, 1);
    assert.match(response.text, /Choose your plan/);
    assert.match(response.text, /Monthly prices add 18% GST/);
    assert.doesNotMatch(response.text, /provider data|walletBalancePaise\s*:/);
  } finally {
    Provider.findOne = originalFindOne;
  }
});

test("cookie authentication re-reads the provider and payment writes require CSRF", async () => {
  const authMiddleware = source("middleware/auth.js");
  const walletRoutes = source("routes/wallet.js");
  const leadRoutes = source("routes/lead.js");
  assert.match(authMiddleware, /Provider\.findOne/);
  assert.match(authMiddleware, /ensureProviderEligible/);
  assert.doesNotMatch(authMiddleware, /new Map|cache|sessionStore/i);
  assert.match(walletRoutes, /verifyCsrf/);
  assert.match(leadRoutes, /verifyCsrf/);

  const providerId = "d".repeat(32);
  const originalFindOne = Provider.findOne;
  Provider.findOne = () => ({
    lean: async () => ({
      providerId,
      name: "Test Provider",
      status: "active",
      portalAccessEnabled: true,
      categorySlugs: ["painting"],
      walletBalancePaise: 0,
    }),
  });

  try {
    const token = createSessionToken(providerId);
    const response = await request(app)
      .post("/api/lead/example/unlock")
      .set("Cookie", [`provider_auth=${token}`])
      .send({});
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "CSRF_INVALID");
  } finally {
    Provider.findOne = originalFindOne;
  }
});


test("locked lead JSON removes contact fields and contact-like additional details", () => {
  const locked = presentLead({
    leadDistributionId: "b".repeat(32),
    enquiryId: "c".repeat(32),
    status: "offered",
    contactUnlocked: false,
    customerName: "Private Customer",
    customerMobile: "9999999999",
    customerEmail: "private@example.com",
    customerAddress: "Private address",
    additionalDetails: {
      propertyType: "Apartment",
      alternatePhone: "8888888888",
      nested: { customerEmail: "hidden@example.com", budget: "10000" },
    },
  });

  assert.equal(locked.customerName, undefined);
  assert.equal(locked.customerMobile, undefined);
  assert.equal(locked.additionalDetails.alternatePhone, undefined);
  assert.equal(locked.additionalDetails.nested.customerEmail, undefined);
  assert.equal(locked.additionalDetails.propertyType, "Apartment");
  assert.equal(locked.additionalDetails.nested.budget, "10000");
});
