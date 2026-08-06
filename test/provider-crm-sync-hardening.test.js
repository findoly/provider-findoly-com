"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");

function withEnv(values, work) {
  const original = {};
  for (const [key, value] of Object.entries(values)) {
    original[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return work();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("contact normalization shares one phone namespace for mobile and WhatsApp", () => {
  const { normalizePhone, normalizeEmail, contactEntries } = require("../utils/contact-normalization");
  assert.equal(normalizePhone("+91 98765 43210"), "9876543210");
  assert.equal(normalizePhone("09876543210"), "9876543210");
  assert.equal(normalizeEmail(" USER@Example.COM "), "user@example.com");
  assert.deepEqual(contactEntries({
    mobile: "9876543210",
    whatsappNumber: "+91 9876543210",
    email: "USER@example.com",
  }), [
    { key: "phone:9876543210", kind: "phone", value: "9876543210", field: "mobile" },
    { key: "email:user@example.com", kind: "email", value: "user@example.com", field: "email" },
  ]);
});

test("provider and joining-request schemas match the CRM contact contract", () => {
  const provider = source("models/Provider.js");
  const request = source("models/ProviderJoinRequest.js");
  const identity = source("models/ContactIdentity.js");

  for (const field of ["whatsappNumber", "normalizedWhatsappNumber", "normalizedEmail"]) {
    assert.match(provider, new RegExp(`${field}:`));
  }
  assert.match(provider, /name:\s*"provider_mobile_unique"/);
  assert.match(provider, /name:\s*"provider_whatsapp_unique"/);
  assert.match(provider, /name:\s*"provider_email_unique"/);
  assert.match(request, /normalizedEmail/);
  assert.match(request, /conversionLockAt/);
  assert.match(request, /conversionLockBy/);
  assert.match(identity, /collection:\s*"contactidentities"/);
  assert.match(identity, /key: \{ type: String, required: true, unique: true/);
});

test("public provider joining reserves shared contact identities transactionally", () => {
  const service = source("services/provider-request/provider-request-service.js");
  const contacts = source("services/contact-identity/contact-identity-service.js");
  const controller = source("controllers/providerRequestController.js");

  assert.match(service, /withTransaction/);
  assert.match(service, /ProviderJoinRequest\.create\(\[/);
  assert.match(service, /syncEntityContacts/);
  assert.match(service, /normalizedWhatsappNumber: whatsappNumber/);
  assert.match(service, /normalizedEmail/);
  assert.match(contacts, /collectionName: "agents"/);
  assert.match(contacts, /collectionName: "crmemployees"/);
  assert.match(contacts, /contactEntries/);
  assert.match(contacts, /support@findoly\.com/);
  assert.doesNotMatch(controller, /already exists for this mobile number/);
});

test("provider login prefers indexed normalized mobile and disables regex fallback in production", () => {
  const auth = source("services/auth/auth-service.js");
  assert.match(auth, /Provider\.findOne\(\{ normalizedMobile: mobile \}\)/);
  assert.match(auth, /PROVIDER_LEGACY_MOBILE_LOOKUP/);
  assert.match(auth, /return String\(env\.NODE_ENV \|\| ""\)\.trim\(\) !== "production"/);
  const findProviderSource = auth.slice(auth.indexOf("async function findProvider"));
  assert.ok(findProviderSource.indexOf("Provider.findOne({ normalizedMobile: mobile })") < findProviderSource.indexOf("mobilePattern(mobile)"));
});

test("production environment requires an explicit shared database and manual indexes", () => {
  const { validateEnvironment } = require("../config/env");
  assert.throws(() => withEnv({
    NODE_ENV: "production",
    MONGODB_URI: "mongodb+srv://user:pass@example.mongodb.net/",
    JWT_SECRET: "a".repeat(40),
    MONGO_AUTO_INDEX: "false",
  }, validateEnvironment), /explicit database name/);

  assert.throws(() => withEnv({
    NODE_ENV: "production",
    MONGODB_URI: "mongodb+srv://user:pass@example.mongodb.net/findoly_prod",
    JWT_SECRET: "a".repeat(40),
    MONGO_AUTO_INDEX: "true",
  }, validateEnvironment), /MONGO_AUTO_INDEX must remain false/);

  assert.throws(() => withEnv({
    NODE_ENV: "production",
    MONGODB_URI: "mongodb+srv://user:pass@example.mongodb.net/findoly_prod",
    JWT_SECRET: "a".repeat(40),
    MONGO_AUTO_INDEX: "false",
  }, validateEnvironment), /CRM_API_BASE_URL and COMMUNICATION_EVENT_API_TOKEN are required/);

  assert.doesNotThrow(() => withEnv({
    NODE_ENV: "production",
    MONGODB_URI: "mongodb+srv://user:pass@example.mongodb.net/findoly_prod",
    PROVIDER_EXPECTED_DATABASE_NAME: "findoly_prod",
    JWT_SECRET: "a".repeat(40),
    MONGO_AUTO_INDEX: "false",
    CRM_API_BASE_URL: "https://crm.example.com",
    COMMUNICATION_EVENT_API_TOKEN: "c".repeat(40),
    PROVIDER_CRM_ACTION_API_TOKEN: "p".repeat(48),
  }, validateEnvironment));
});

test("provider index provisioning includes the shared CRM collections", () => {
  const indexes = source("scripts/ensure-indexes.js");
  const contract = source("db/shared-contract.js");
  const pkg = JSON.parse(source("package.json"));
  assert.match(indexes, /require\("\.\.\/models\/Provider"\)/);
  assert.match(indexes, /require\("\.\.\/models\/ProviderJoinRequest"\)/);
  assert.match(indexes, /require\("\.\.\/models\/ContactIdentity"\)/);
  assert.match(indexes, /require\("\.\.\/models\/ProviderCrmSyncEvent"\)/);
  assert.match(indexes, /verifySharedIndexes/);
  assert.match(contract, /MONGODB_TRANSACTIONS_REQUIRED/);
  assert.match(contract, /SHARED_INDEXES_MISSING/);
  assert.equal(pkg.scripts["verify:indexes"], "node scripts/run-with-runtime.js scripts/ensure-indexes.js --verify-only");
});
