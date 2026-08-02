const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("Razorpay webhook keeps the raw body before JSON and text middleware", () => {
  const app = read("app.js");
  const webhook = app.indexOf('app.post(\n  "/api/webhooks/razorpay"');
  const json = app.indexOf("app.use(express.json");
  const plainText = app.indexOf("app.use(rejectUnsupportedFormText)");
  assert.ok(webhook >= 0 && json > webhook && plainText > json);
  assert.match(app, /express\.raw\(\{ type: "application\/json", limit: "256kb" \}\)/);
});

test("payment verification uses signatures, gateway verification and idempotent order state", () => {
  const wallet = read("services/wallet/wallet-service.js");
  assert.match(wallet, /verifyCheckoutSignature/);
  assert.match(wallet, /safeSignatureEqual\(expected, signature\)/);
  assert.match(wallet, /Invalid Razorpay payment signature/);
  assert.match(wallet, /fetchPayment\(paymentOrder, razorpayPaymentId\)/);
  assert.match(wallet, /status: "verified"/);
  assert.match(wallet, /Invalid Razorpay webhook signature/);
});

test("provider subscriptions continue to use the shared CRM collection", () => {
  const model = read("models/ProviderSubscription.js");
  const wallet = read("services/wallet/wallet-service.js");
  assert.match(model, /collection:\s*"providersubscriptions"/);
  assert.match(wallet, /ProviderSubscription/);
  assert.match(wallet, /providerSubscriptionId/);
  assert.match(wallet, /startsAt/);
  assert.match(wallet, /expiresAt/);
});

test("provider lead presentation uses current CRM priority and compact service type snapshots", () => {
  const presenter = read("utils/lead.js");
  const unlockService = read("services/lead/lead-service.js");
  assert.match(presenter, /priority: enquiry\.priority \|\| unlock\?\.priority \|\| "normal"/);
  assert.match(presenter, /serviceTypes\(enquiry\.serviceTypes \|\| unlock\?\.serviceTypes\)/);
  assert.match(unlockService, /Array\.isArray\(enquiry\.serviceTypes\)/);
  assert.match(unlockService, /slice\(0, 5\)/);
});

test("provider form validation is mounted for all parsed API and page form bodies", () => {
  const app = read("app.js");
  const middleware = read("middleware/plain-text.js");
  assert.match(app, /app\.use\(rejectUnsupportedFormText\)/);
  assert.match(middleware, /Extended_Pictographic/);
  assert.match(middleware, /must not contain HTML tags or encoded HTML/);
  assert.match(middleware, /Object\.entries\(value\)/);
});

test("review OTP is secret-backed, expiring, non-production only and not browser-exposed", () => {
  const auth = read("services/auth/auth-service.js");
  const env = read("config/env.js");
  const controller = read("controllers/authController.js");
  const login = read("views/auth/login.ejs");

  assert.doesNotMatch(auth, /8693097982|7777/);
  assert.match(auth, /RAZORPAY_REVIEW_MOBILE/);
  assert.match(auth, /RAZORPAY_REVIEW_OTP/);
  assert.match(auth, /RAZORPAY_REVIEW_EXPIRES_AT/);
  assert.match(auth, /NODE_ENV[\s\S]*production/);
  assert.match(env, /RAZORPAY_REVIEW_LOGIN_ENABLED must be false in production/);
  assert.doesNotMatch(`${controller}
${login}`, /RAZORPAY_REVIEW_MOBILE|RAZORPAY_REVIEW_OTP|RAZORPAY_REVIEW_EXPIRES_AT/);
});
