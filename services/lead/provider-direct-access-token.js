"use strict";

const crypto = require("node:crypto");

const TOKEN_PREFIX = "findoly_direct_lead_v1";
const MAX_TOKEN_LENGTH = 1024;

function configurationError() {
  return Object.assign(new Error("Employee direct lead links are not configured"), {
    status: 503,
    code: "DIRECT_LEAD_LINK_NOT_CONFIGURED",
  });
}

function signingKey(env = process.env) {
  const secret = String(
    env.PROVIDER_DIRECT_LEAD_LINK_SECRET
      || env.COMMUNICATION_EVENT_API_TOKEN
      || "",
  ).trim();
  if (secret.length < 32) throw configurationError();
  return crypto
    .createHash("sha256")
    .update(`findoly-provider-direct-lead-v1\0${secret}`, "utf8")
    .digest();
}

function signatureFor(payloadPart, env = process.env) {
  return crypto
    .createHmac("sha256", signingKey(env))
    .update(`${TOKEN_PREFIX}.${payloadPart}`, "utf8")
    .digest("base64url");
}

function safeEqual(left, right) {
  const first = Buffer.from(String(left || ""));
  const second = Buffer.from(String(right || ""));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function accessError(message, status = 401, code = "DIRECT_LEAD_LINK_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function verify(token, { providerId, enquiryId, now = new Date(), env = process.env } = {}) {
  const normalized = String(token || "").trim();
  if (!normalized || normalized.length > MAX_TOKEN_LENGTH) {
    throw accessError("This employee-shared lead link is invalid");
  }
  const parts = normalized.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    throw accessError("This employee-shared lead link is invalid");
  }
  if (!safeEqual(parts[2], signatureFor(parts[1], env))) {
    throw accessError("This employee-shared lead link is invalid");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (_error) {
    throw accessError("This employee-shared lead link is invalid");
  }

  const expectedProviderId = String(providerId || "").trim();
  const expectedEnquiryId = String(enquiryId || "").trim();
  if (
    !payload
    || String(payload.p || "") !== expectedProviderId
    || String(payload.e || "") !== expectedEnquiryId
    || !Number.isInteger(payload.i)
    || !Number.isInteger(payload.x)
  ) {
    throw accessError("This employee-shared lead link is not valid for your account", 403, "DIRECT_LEAD_LINK_ACCOUNT_MISMATCH");
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (payload.i > nowSeconds + 300) {
    throw accessError("This employee-shared lead link is invalid");
  }
  if (payload.x < nowSeconds) {
    throw accessError("This employee-shared lead link has expired", 410, "DIRECT_LEAD_LINK_EXPIRED");
  }

  return {
    providerId: expectedProviderId,
    enquiryId: expectedEnquiryId,
    issuedAt: new Date(payload.i * 1000),
    expiresAt: new Date(payload.x * 1000),
  };
}

module.exports = {
  TOKEN_PREFIX,
  MAX_TOKEN_LENGTH,
  signingKey,
  signatureFor,
  verify,
};
