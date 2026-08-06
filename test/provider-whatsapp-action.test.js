"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..");

function source(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function loadWithStubs(relativePath, stubs) {
  const absolute = require.resolve(path.join(root, relativePath));
  delete require.cache[absolute];
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(absolute);
  } finally {
    Module._load = originalLoad;
    delete require.cache[absolute];
  }
}

function actionBody(overrides = {}) {
  return {
    providerId: "provider-1",
    enquiryId: "enquiry-1",
    providerWhatsapp: "919867079691",
    communicationId: "communication-1",
    inboundMessageId: "inbound-1",
    originalProviderMessageId: "outbound-1",
    requestedAt: "2026-08-06T15:30:00.000Z",
    idempotencyKey: "whatsapp-action-1",
    ...overrides,
  };
}

function actionHeaders(overrides = {}) {
  return {
    "x-idempotency-key": "whatsapp-action-1",
    "x-request-id": "request-1",
    ...overrides,
  };
}

function queryResult(value) {
  return {
    select() { return this; },
    async lean() { return value; },
  };
}

test("Provider Portal mounts the authenticated internal WhatsApp action endpoint before session API routes", () => {
  const app = source("app.js");
  const route = source("routes/internal-whatsapp.js");
  const internalMount = app.indexOf('"/api/internal/whatsapp"');
  const providerSession = app.indexOf("app.use(attachProvider)");
  assert.ok(internalMount >= 0 && providerSession > internalMount);
  assert.match(route, /router\.post\("\/lead-unlock", authorized, controller\.viewEnquiry\)/);
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /PROVIDER_CRM_ACTION_API_TOKEN/);
});

test("internal WhatsApp action rejects a missing or incorrect Bearer token", () => {
  const previous = process.env.PROVIDER_CRM_ACTION_API_TOKEN;
  process.env.PROVIDER_CRM_ACTION_API_TOKEN = "a".repeat(48);
  const router = loadWithStubs("routes/internal-whatsapp.js", {
    express: { Router() { return { post() {} }; } },
    "../controllers/internalWhatsappController": {},
  });
  let nextCalled = false;
  let responseStatus = 0;
  let responseBody = null;
  const req = {
    requestId: "request-1",
    get() { return "Bearer wrong-token"; },
  };
  const res = {
    status(value) { responseStatus = value; return this; },
    json(value) { responseBody = value; return value; },
  };
  try {
    router.authorized(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(responseStatus, 401);
    assert.equal(responseBody.code, "PROVIDER_ACTION_UNAUTHORIZED");
  } finally {
    if (previous === undefined) delete process.env.PROVIDER_CRM_ACTION_API_TOKEN;
    else process.env.PROVIDER_CRM_ACTION_API_TOKEN = previous;
  }
});

test("internal WhatsApp action accepts the matching Bearer token", () => {
  const previous = process.env.PROVIDER_CRM_ACTION_API_TOKEN;
  const token = "b".repeat(48);
  process.env.PROVIDER_CRM_ACTION_API_TOKEN = token;
  const router = loadWithStubs("routes/internal-whatsapp.js", {
    express: { Router() { return { post() {} }; } },
    "../controllers/internalWhatsappController": {},
  });
  let nextCalled = false;
  try {
    router.authorized({ get: () => `Bearer ${token}` }, {}, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  } finally {
    if (previous === undefined) delete process.env.PROVIDER_CRM_ACTION_API_TOKEN;
    else process.env.PROVIDER_CRM_ACTION_API_TOKEN = previous;
  }
});

test("WhatsApp action validates request and idempotency identifiers", () => {
  const service = loadWithStubs("services/lead/whatsapp-action-service.js", {
    "../../models/Provider": {},
    "../../models/ProviderLeadUnlock": {},
    "./lead-service": {},
  });
  assert.throws(
    () => service.requestInput(actionBody(), actionHeaders({ "x-idempotency-key": "different" })),
    /does not match/,
  );
  assert.throws(
    () => service.requestInput(actionBody({ communicationId: "" }), actionHeaders()),
    /Communication ID is invalid/,
  );
  assert.throws(
    () => service.requestInput(actionBody({ requestedAt: "not-a-date" }), actionHeaders()),
    /Requested at is invalid/,
  );
});

test("successful WhatsApp action reuses the transactional lead service and returns customer details", async () => {
  const provider = {
    providerId: "provider-1",
    name: "Provider",
    status: "active",
    portalAccessEnabled: true,
    normalizedWhatsappNumber: "9867079691",
    walletBalancePaise: 5000,
  };
  const updatedProvider = { ...provider, walletBalancePaise: 3500 };
  let providerReads = 0;
  let unlockCalls = 0;
  const service = loadWithStubs("services/lead/whatsapp-action-service.js", {
    "../../models/Provider": {
      findOne() {
        providerReads += 1;
        return queryResult(providerReads === 1 ? provider : updatedProvider);
      },
    },
    "../../models/ProviderLeadUnlock": {
      findOne() { return queryResult(null); },
    },
    "./lead-service": {
      async unlock(receivedProvider, enquiryId) {
        unlockCalls += 1;
        assert.equal(receivedProvider.providerId, "provider-1");
        assert.equal(enquiryId, "enquiry-1");
        return {
          enquiryId,
          customerName: "Customer",
          customerMobile: "9999999999",
          chargedCredits: 15,
        };
      },
    },
  });

  const result = await service.processAction(actionBody(), actionHeaders());
  assert.equal(result.status, "unlocked");
  assert.equal(result.lead.customerName, "Customer");
  assert.equal(result.provider.availableCredits, 35);
  assert.equal(unlockCalls, 1);
});

test("a repeated WhatsApp action reports the enquiry as already available and delegates to the idempotent lead service", async () => {
  const provider = {
    providerId: "provider-1",
    status: "active",
    portalAccessEnabled: true,
    normalizedWhatsappNumber: "9867079691",
    walletBalancePaise: 3500,
  };
  let unlockCalls = 0;
  const service = loadWithStubs("services/lead/whatsapp-action-service.js", {
    "../../models/Provider": {
      findOne() { return queryResult(provider); },
    },
    "../../models/ProviderLeadUnlock": {
      findOne() { return queryResult({ providerLeadUnlockId: "unlock-1" }); },
    },
    "./lead-service": {
      async unlock() {
        unlockCalls += 1;
        return { enquiryId: "enquiry-1", customerName: "Customer", chargedCredits: 15 };
      },
    },
  });

  const result = await service.processAction(actionBody(), actionHeaders());
  assert.equal(result.status, "already_unlocked");
  assert.equal(unlockCalls, 1);
  assert.match(source("services/lead/lead-service.js"), /const existing = await ProviderLeadUnlock\.findOne/);
  assert.match(source("models/ProviderLeadUnlock.js"), /\{ providerId: 1, enquiryId: 1 \}, \{ unique: true \}/);
});

test("WhatsApp action maps business failures without bypassing existing lead rules", async () => {
  const provider = {
    providerId: "provider-1",
    status: "active",
    portalAccessEnabled: true,
    normalizedWhatsappNumber: "9867079691",
  };
  const cases = [
    [{ code: "INSUFFICIENT_BALANCE", requiredCredits: 20, availableCredits: 5 }, "insufficient_credits"],
    [{ code: "DIRECT_PAYMENT_PENDING" }, "direct_payment_pending"],
    [{ code: "LEAD_NOT_AVAILABLE" }, "lead_unavailable"],
  ];

  for (const [failure, expectedStatus] of cases) {
    const service = loadWithStubs("services/lead/whatsapp-action-service.js", {
      "../../models/Provider": { findOne() { return queryResult(provider); } },
      "../../models/ProviderLeadUnlock": { findOne() { return queryResult(null); } },
      "./lead-service": {
        async unlock() { throw Object.assign(new Error("business failure"), failure); },
      },
    });
    const result = await service.processAction(actionBody(), actionHeaders());
    assert.equal(result.status, expectedStatus);
  }
});

test("inactive providers are ineligible and WhatsApp-number mismatches are rejected", async () => {
  const inactiveService = loadWithStubs("services/lead/whatsapp-action-service.js", {
    "../../models/Provider": {
      findOne() {
        return queryResult({ providerId: "provider-1", status: "inactive", normalizedWhatsappNumber: "9867079691" });
      },
    },
    "../../models/ProviderLeadUnlock": {},
    "./lead-service": {},
  });
  const inactive = await inactiveService.processAction(actionBody(), actionHeaders());
  assert.equal(inactive.status, "provider_ineligible");

  const mismatchService = loadWithStubs("services/lead/whatsapp-action-service.js", {
    "../../models/Provider": {
      findOne() {
        return queryResult({
          providerId: "provider-1",
          status: "active",
          portalAccessEnabled: true,
          normalizedWhatsappNumber: "9999999999",
        });
      },
    },
    "../../models/ProviderLeadUnlock": {},
    "./lead-service": {},
  });
  await assert.rejects(
    mismatchService.processAction(actionBody(), actionHeaders()),
    (error) => error.status === 403 && error.code === "PROVIDER_WHATSAPP_MISMATCH",
  );
});

test("production environment requires a strong Provider CRM action token", () => {
  const env = source("config/env.js");
  assert.match(env, /PROVIDER_CRM_ACTION_API_TOKEN is required in production/);
  assert.match(env, /PROVIDER_CRM_ACTION_API_TOKEN must be a strong production secret/);
});


test("Provider Portal action authentication logs only safe credential fingerprints", () => {
  const previous = process.env.PROVIDER_CRM_ACTION_API_TOKEN;
  const configured = "configured-secret-value-that-must-never-be-logged";
  const supplied = "supplied-secret-value-that-must-never-be-logged";
  process.env.PROVIDER_CRM_ACTION_API_TOKEN = configured;
  const router = loadWithStubs("routes/internal-whatsapp.js", {
    express: { Router() { return { post() {} }; } },
    "../controllers/internalWhatsappController": {},
  });
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const logs = [];
  console.info = (entry) => logs.push(entry);
  console.warn = (entry) => logs.push(entry);
  try {
    router.authorized({
      requestId: "request-1",
      body: actionBody(),
      get: () => `Bearer ${supplied}`,
    }, {
      status() { return this; },
      json(value) { return value; },
    }, () => assert.fail("mismatched credentials must not be authorized"));
    const failed = logs.find((entry) => entry.event === "provider_whatsapp_action_auth_failed");
    assert.ok(failed);
    assert.equal(failed.configuredCredentialFingerprint.length, 12);
    assert.equal(failed.suppliedCredentialFingerprint.length, 12);
    const serialized = JSON.stringify(logs);
    assert.doesNotMatch(serialized, new RegExp(configured));
    assert.doesNotMatch(serialized, new RegExp(supplied));
    assert.doesNotMatch(serialized, /9867079691|919867079691/);
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
    if (previous === undefined) delete process.env.PROVIDER_CRM_ACTION_API_TOKEN;
    else process.env.PROVIDER_CRM_ACTION_API_TOKEN = previous;
  }
});

test("WhatsApp action exposes provider, enquiry, transaction and internal failure categories", () => {
  const service = loadWithStubs("services/lead/whatsapp-action-service.js", {
    "../../models/Provider": {},
    "../../models/ProviderLeadUnlock": {},
    "./lead-service": {},
  });
  assert.equal(service.businessFailure({ code: "PROVIDER_NOT_FOUND" }).status, "provider_not_found");
  assert.equal(service.businessFailure({ code: "PROVIDER_INACTIVE" }).status, "provider_ineligible");
  assert.equal(service.businessFailure({ code: "LEAD_NOT_FOUND" }).status, "enquiry_not_found");
  assert.equal(service.businessFailure({ code: "LEAD_UNLOCK_CONFLICT" }).status, "lead_unavailable");
  assert.equal(service.businessFailure({ code: "MONGODB_TRANSACTIONS_REQUIRED" }).status, "transaction_failed");
  assert.equal(service.businessFailure({}).status, "internal_error");
});

test("WhatsApp action service emits safe processing logs and passes diagnostic context to lead service", async () => {
  const provider = {
    providerId: "provider-1",
    status: "active",
    portalAccessEnabled: true,
    normalizedWhatsappNumber: "9867079691",
    walletBalancePaise: 5000,
  };
  let receivedOptions = null;
  const service = loadWithStubs("services/lead/whatsapp-action-service.js", {
    "../../models/Provider": { findOne() { return queryResult(provider); } },
    "../../models/ProviderLeadUnlock": { findOne() { return queryResult(null); } },
    "./lead-service": {
      async unlock(_provider, _enquiryId, options) {
        receivedOptions = options;
        return { enquiryId: "enquiry-1", chargedCredits: 10 };
      },
    },
  });
  const originalInfo = console.info;
  const logs = [];
  console.info = (entry) => logs.push(entry);
  try {
    const result = await service.processAction(actionBody(), actionHeaders(), { requestId: "request-1" });
    assert.equal(result.status, "unlocked");
    assert.equal(receivedOptions.source, "whatsapp_action");
    assert.equal(receivedOptions.communicationId, "communication-1");
    assert.ok(logs.some((entry) => entry.event === "provider_whatsapp_action_provider_lookup_completed"));
    assert.ok(logs.some((entry) => entry.event === "provider_whatsapp_action_lead_access_completed"));
    assert.doesNotMatch(JSON.stringify(logs), /9867079691|919867079691/);
  } finally {
    console.info = originalInfo;
  }
});

test("Provider lead transaction diagnostics are limited to WhatsApp action calls", () => {
  const lead = source("services/lead/lead-service.js");
  assert.match(lead, /options\.source[^\n]+whatsapp_action/);
  assert.match(lead, /provider_whatsapp_credit_transaction_started/);
  assert.match(lead, /provider_whatsapp_credit_decision/);
  assert.match(lead, /provider_whatsapp_credit_transaction_completed/);
  assert.match(lead, /provider_whatsapp_credit_transaction_rolled_back/);
});

test("Provider Portal mounts structured request logging and forwards Morgan output to CloudWatch console capture", () => {
  const app = source("app.js");
  assert.match(app, /requestLoggingMiddleware/);
  assert.match(app, /morganCloudWatchStream/);
  assert.ok(app.indexOf("app.use(requestLoggingMiddleware)") < app.indexOf("helmet({"));
});
