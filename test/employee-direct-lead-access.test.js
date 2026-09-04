"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const tokenService = require("../services/lead/provider-direct-access-token");
const directAccessService = require("../services/lead/provider-direct-access-service");

const SECRET = "test-direct-link-secret-with-more-than-32-characters";

function makeToken({ providerId = "provider-1", enquiryId = "lead-1", issuedAt = 1_700_000_000, expiresAt = 1_700_086_400 } = {}) {
  const payloadPart = Buffer.from(JSON.stringify({
    p: providerId,
    e: enquiryId,
    i: issuedAt,
    x: expiresAt,
  }), "utf8").toString("base64url");
  const signature = tokenService.signatureFor(payloadPart, { PROVIDER_DIRECT_LEAD_LINK_SECRET: SECRET });
  return `${tokenService.TOKEN_PREFIX}.${payloadPart}.${signature}`;
}

test("employee direct lead token is bound to provider and enquiry", () => {
  const now = new Date(1_700_010_000 * 1000);
  const token = makeToken();
  const verified = tokenService.verify(token, {
    providerId: "provider-1",
    enquiryId: "lead-1",
    now,
    env: { PROVIDER_DIRECT_LEAD_LINK_SECRET: SECRET },
  });
  assert.equal(verified.providerId, "provider-1");
  assert.equal(verified.enquiryId, "lead-1");
  assert.throws(
    () => tokenService.verify(token, {
      providerId: "provider-2",
      enquiryId: "lead-1",
      now,
      env: { PROVIDER_DIRECT_LEAD_LINK_SECRET: SECRET },
    }),
    (error) => error.code === "DIRECT_LEAD_LINK_ACCOUNT_MISMATCH",
  );
});

test("employee direct lead token expires independently of the provider session", () => {
  const token = makeToken({ expiresAt: 1_700_000_100 });
  assert.throws(
    () => tokenService.verify(token, {
      providerId: "provider-1",
      enquiryId: "lead-1",
      now: new Date(1_700_000_101 * 1000),
      env: { PROVIDER_DIRECT_LEAD_LINK_SECRET: SECRET },
    }),
    (error) => error.code === "DIRECT_LEAD_LINK_EXPIRED",
  );
});

test("direct access only extends an otherwise valid lead after unlock-limit closure", () => {
  const now = new Date("2026-09-04T10:00:00.000Z");
  const provider = {
    serviceLatitude: 19.076,
    serviceLongitude: 72.8777,
    serviceLocationSource: "geocoded",
  };
  const base = {
    status: "approved",
    isActive: true,
    marketplacePublishedAt: new Date("2026-09-03T00:00:00.000Z"),
    marketplaceExpiresAt: new Date("2026-09-05T00:00:00.000Z"),
    locationLatitude: 19.076,
    locationLongitude: 72.8777,
    locationSource: "geocoded",
    remainingUnlocks: 0,
    marketplaceAvailable: false,
    marketplaceStatus: "closed",
    marketplaceClosureReason: "unlock_limit",
  };
  assert.equal(directAccessService.lifecycleAllowsDirectAccess(provider, base, now), true);
  assert.equal(directAccessService.lifecycleAllowsDirectAccess(provider, { ...base, marketplaceClosureReason: "deactivated" }, now), false);
  assert.equal(directAccessService.lifecycleAllowsDirectAccess(provider, { ...base, isActive: false }, now), false);
  assert.equal(directAccessService.lifecycleAllowsDirectAccess(provider, { ...base, marketplaceExpiresAt: new Date("2026-09-04T09:00:00.000Z") }, now), false);
});

test("full-cap credit and direct-payment paths keep remaining unlocks at zero", () => {
  const leadService = fs.readFileSync(path.join(__dirname, "../services/lead/lead-service.js"), "utf8");
  const paymentService = fs.readFileSync(path.join(__dirname, "../services/wallet/lead-payment-service.js"), "utf8");
  assert.match(leadService, /marketplaceClosureReason: "unlock_limit"/);
  assert.match(leadService, /\$inc: \{ unlockedCount: 1 \}/);
  assert.match(leadService, /\$set: \{ remainingUnlocks: 0, updatedAt: now \}/);
  assert.match(paymentService, /employeeDirectAccessOverride/);
  assert.match(paymentService, /order\.employeeDirectAccessOverride === true/);
});

test("legacy singular lead URL redirects to canonical plural route", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../routes/frontend.js"), "utf8");
  assert.match(routes, /router\.get\("\/lead\/:leadId"/);
  assert.match(routes, /`\/leads\/\$\{encodeURIComponent\(req\.params\.leadId\)\}\$\{query\}`/);
  assert.match(routes, /captureForPage/);
});

test("test helper signs with the same HMAC primitive used by production", () => {
  const payload = "sample";
  const key = tokenService.signingKey({ PROVIDER_DIRECT_LEAD_LINK_SECRET: SECRET });
  const expected = crypto.createHmac("sha256", key)
    .update(`${tokenService.TOKEN_PREFIX}.${payload}`, "utf8")
    .digest("base64url");
  assert.equal(tokenService.signatureFor(payload, { PROVIDER_DIRECT_LEAD_LINK_SECRET: SECRET }), expected);
});
