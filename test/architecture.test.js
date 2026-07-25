const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { presentLead } = require("../utils/lead");

const root = path.join(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");

function activeLeadSources() {
  return [
    "models/Enquiry.js",
    "models/ProviderLeadUnlock.js",
    "models/PaymentOrder.js",
    "services/marketplace/marketplace-service.js",
    "services/lead/lead-service.js",
    "services/wallet/lead-payment-service.js",
    "controllers/leadController.js",
    "routes/lead.js",
    "views/lead/index.ejs",
    "views/lead/show.ejs",
  ].map(source).join("\n");
}

test("marketplace architecture stores one enquiry and creates provider rows only after unlock", () => {
  assert.equal(fs.existsSync(path.join(root, "models/LeadDistribution.js")), false);
  assert.equal(fs.existsSync(path.join(root, "services/marketplace/offer-service.js")), false);
  const model = source("models/ProviderLeadUnlock.js");
  assert.match(model, /collection:\s*"providerleadunlocks"/);
  assert.match(model, /\{ providerId: 1, enquiryId: 1 \}, \{ unique: true \}/);
  assert.match(source("services/marketplace/marketplace-service.js"), /Enquiry\.find\(/);
  assert.match(source("services/lead/lead-service.js"), /ProviderLeadUnlock\.create/);
});

test("redesigned lead workflow avoids aggregation, expression queries, deep skip and legacy distribution terms", () => {
  const text = activeLeadSources();
  assert.doesNotMatch(text, /LeadDistribution|leaddistributions|leadDistributionId|pendingUnlockCount/);
  assert.doesNotMatch(text, /\.aggregate\s*\(|\$expr|\.skip\s*\(/);
  assert.match(text, /cursorPaginate|encodeCursor/);
  assert.match(text, /module\.exports/);
  assert.doesNotMatch(text, /\bexport\s+default\b|\bimport\s+.+from\b/);
});

test("shared model source retains compact public IDs and reservation safeguards", () => {
  const provider = source("models/Provider.js");
  const enquiry = source("models/Enquiry.js");
  const unlock = source("models/ProviderLeadUnlock.js");
  const allocation = source("models/CreditAllocation.js");
  const subscription = source("models/ProviderSubscription.js");
  const payment = source("models/PaymentOrder.js");

  assert.match(provider, /providerId:\s*\{[^}]*default:\s*uuid/s);
  assert.match(enquiry, /enquiryId:\s*\{[^}]*default:\s*uuid/s);
  assert.match(unlock, /providerLeadUnlockId:\s*\{[\s\S]*?default:\s*uuid/);
  assert.match(allocation, /creditAllocationId:\s*\{[^}]*default:\s*uuid/s);
  assert.match(subscription, /providerSubscriptionId:\s*\{[^}]*default:\s*uuid/s);
  assert.match(payment, /activeReservationKey:/);
  assert.match(payment, /reservedUntil:/);
  assert.match(payment, /partialFilterExpression:\s*\{ activeReservationKey:/);
  assert.match(enquiry, /remainingUnlocks:/);
  assert.match(enquiry, /reservedUnlockCount:/);
});

test("credit and direct-payment unlock methods block cross-method concurrency inside transactions", () => {
  const credit = source("services/lead/lead-service.js");
  const direct = source("services/wallet/lead-payment-service.js");
  const keyUtility = source("utils/lead-unlock-key.js");
  assert.match(keyUtility, /module\.exports = \{ activeReservationKey \}/);
  assert.match(credit, /activeReservationKey\(providerId, enquiryId\)/);
  assert.match(credit, /PaymentOrder\.findOne\(\{[\s\S]*?reservationStatus: "reserved"[\s\S]*?\.session\(session\)/);
  assert.match(direct, /ProviderLeadUnlock\.findOne\(\{ providerId, enquiryId \}\)[\s\S]*?\.session\(session\)/);
});

test("Razorpay direct unlock reserves locally before gateway creation and never creates credits", () => {
  const wallet = source("services/wallet/wallet-service.js");
  const direct = source("services/wallet/lead-payment-service.js");
  const createLeadOrder = direct.slice(direct.indexOf("async function createLeadOrder"));
  const localReservation = createLeadOrder.indexOf("PaymentOrder.create");
  const gatewayOrder = createLeadOrder.indexOf("await createRazorpayOrder(provider");
  assert.match(wallet, /verifyCheckoutSignature/);
  assert.match(wallet, /payments\.fetch/);
  assert.ok(localReservation >= 0 && gatewayOrder > localReservation);
  assert.match(direct, /razorpayOrderId:\s*`pending_\$\{paymentOrderId\}`/);
  assert.match(direct, /status:\s*"gateway_pending"/);
  assert.match(direct, /code:\s*"CHECKOUT_PREPARING"/);
  assert.match(direct, /releaseReservation\(paymentOrderId, "gateway_failed"\)/);
  assert.match(direct, /reservationStatus:\s*"reserved"/);
  assert.match(direct, /remainingUnlocks:\s*-1, reservedUnlockCount:\s*1/);
  assert.match(direct, /reservedUnlockCount:\s*-1, unlockedCount:\s*1/);
  assert.match(direct, /ProviderLeadUnlock\.create/);
  assert.doesNotMatch(direct, /addCredits/);
});

test("expired direct-payment reservations are released by a bounded CommonJS cleanup command", () => {
  const direct = source("services/wallet/lead-payment-service.js");
  const cleanup = source("scripts/release-expired-lead-reservations.js");
  const packageJson = JSON.parse(source("package.json"));
  assert.match(direct, /RELEASE_BATCH_SIZE/);
  assert.match(direct, /\.limit\(RELEASE_BATCH_SIZE\)/);
  assert.match(direct, /marketplaceClosureReason:\s*"unlock_limit"/);
  assert.match(direct, /marketplaceClosureReason:\s*""/);
  assert.match(cleanup, /LEAD_PAYMENT_CLEANUP_MAX_BATCHES/);
  assert.match(cleanup, /module\.exports/);
  assert.equal(packageJson.scripts["cleanup:lead-reservations"], "node scripts/release-expired-lead-reservations.js");
});

test("locked lead presenter does not expose customer contact or contact-like details", () => {
  const locked = presentLead({
    enquiryId: "c".repeat(32),
    categorySlug: "painting",
    name: "Private Customer",
    mobile: "9999999999",
    email: "private@example.com",
    addressLine: "Private address",
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
});
