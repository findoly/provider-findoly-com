"use strict";

const Provider = require("../../models/Provider");
const ProviderLeadUnlock = require("../../models/ProviderLeadUnlock");
const leadService = require("./lead-service");
const { normalizeMobile } = require("../../utils/mobile");
const {
  ensureProviderEligible,
  presentProvider,
  providerQuery,
} = require("../../utils/provider");

function validationError(message, code = "INVALID_WHATSAPP_ACTION_REQUEST") {
  return Object.assign(new Error(message), { status: 400, code });
}

function cleanIdentifier(value, label, { required = true, maximum = 128 } = {}) {
  const text = String(value || "").trim();
  if (!text && !required) return "";
  if (!text || text.length > maximum || /[\0\r\n]/.test(text)) {
    throw validationError(`${label} is invalid`);
  }
  return text;
}

function cleanRequestedAt(value) {
  const text = cleanIdentifier(value, "Requested at", { maximum: 64 });
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) {
    throw validationError("Requested at is invalid");
  }
  return date;
}

function requestInput(body = {}, headers = {}) {
  const idempotencyKey = cleanIdentifier(
    body.idempotencyKey || headers["x-idempotency-key"],
    "Idempotency key",
  );
  const headerIdempotencyKey = cleanIdentifier(
    headers["x-idempotency-key"],
    "Idempotency header",
  );
  if (idempotencyKey !== headerIdempotencyKey) {
    throw validationError("Idempotency key does not match its request header");
  }

  return {
    providerId: cleanIdentifier(body.providerId, "Provider ID"),
    enquiryId: cleanIdentifier(body.enquiryId, "Enquiry ID"),
    providerWhatsapp: normalizeMobile(body.providerWhatsapp),
    communicationId: cleanIdentifier(body.communicationId, "Communication ID"),
    inboundMessageId: cleanIdentifier(body.inboundMessageId, "Inbound message ID"),
    originalProviderMessageId: cleanIdentifier(
      body.originalProviderMessageId,
      "Original provider message ID",
      { required: false, maximum: 256 },
    ),
    requestedAt: cleanRequestedAt(body.requestedAt),
    idempotencyKey,
    requestId: cleanIdentifier(headers["x-request-id"], "Request ID"),
  };
}

function providerWhatsapp(provider = {}) {
  return normalizeMobile(
    provider.normalizedWhatsappNumber
      || provider.whatsappNumber
      || provider.normalizedMobile
      || provider.mobile,
  );
}

function businessFailure(error = {}) {
  const code = String(error.code || "");
  if (code === "INSUFFICIENT_BALANCE") {
    return {
      status: "insufficient_credits",
      code,
      requiredCredits: Number(error.requiredCredits || 0),
      availableCredits: Number(error.availableCredits || 0),
    };
  }
  if (code === "DIRECT_PAYMENT_PENDING") {
    return { status: "direct_payment_pending", code };
  }
  if ([
    "PROVIDER_NOT_FOUND",
    "PROVIDER_INACTIVE",
    "PORTAL_ACCESS_DISABLED",
    "PROVIDER_ID_MISSING",
  ].includes(code)) {
    return { status: "provider_ineligible", code };
  }
  if (["LEAD_NOT_FOUND", "LEAD_NOT_AVAILABLE", "LEAD_UNLOCK_CONFLICT"].includes(code)) {
    return { status: "lead_unavailable", code };
  }
  return { status: "failed", code: code || "WHATSAPP_ACTION_FAILED" };
}

async function loadProvider(providerId) {
  const provider = await Provider.findOne(providerQuery(providerId)).lean();
  return ensureProviderEligible(provider);
}

async function currentProvider(providerId, fallback = {}) {
  try {
    const provider = await Provider.findOne(providerQuery(providerId)).lean();
    return presentProvider(provider || fallback);
  } catch (_error) {
    return presentProvider(fallback);
  }
}

async function processAction(body = {}, headers = {}) {
  const input = requestInput(body, headers);
  if (!/^[6-9]\d{9}$/.test(input.providerWhatsapp)) {
    throw validationError("Provider WhatsApp number is invalid", "PROVIDER_WHATSAPP_INVALID");
  }

  let provider;
  try {
    provider = await loadProvider(input.providerId);
  } catch (error) {
    return businessFailure(error);
  }

  if (providerWhatsapp(provider) !== input.providerWhatsapp) {
    throw Object.assign(new Error("Provider WhatsApp number does not match the registered account"), {
      status: 403,
      code: "PROVIDER_WHATSAPP_MISMATCH",
    });
  }

  const existing = await ProviderLeadUnlock.findOne({
    providerId: input.providerId,
    enquiryId: input.enquiryId,
  }).select({ providerLeadUnlockId: 1 }).lean();

  try {
    const lead = await leadService.unlock(provider, input.enquiryId);
    return {
      status: existing ? "already_unlocked" : "unlocked",
      lead,
      provider: await currentProvider(input.providerId, provider),
      request: {
        communicationId: input.communicationId,
        inboundMessageId: input.inboundMessageId,
        originalProviderMessageId: input.originalProviderMessageId,
        idempotencyKey: input.idempotencyKey,
        requestId: input.requestId,
        requestedAt: input.requestedAt.toISOString(),
      },
    };
  } catch (error) {
    return businessFailure(error);
  }
}

module.exports = {
  processAction,
  requestInput,
  providerWhatsapp,
  businessFailure,
};
