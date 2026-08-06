"use strict";

const crypto = require("crypto");
const express = require("express");
const controller = require("../controllers/internalWhatsappController");

const router = express.Router();

function safeIdentifier(value, maximum = 128) {
  return String(value || "").replace(/[\0\r\n]/g, "").trim().slice(0, maximum);
}

function credentialFingerprint(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

function actionContext(req = {}) {
  return {
    requestId: safeIdentifier(req.requestId, 80),
    providerId: safeIdentifier(req.body?.providerId),
    enquiryId: safeIdentifier(req.body?.enquiryId),
    communicationId: safeIdentifier(req.body?.communicationId),
    inboundMessageId: safeIdentifier(req.body?.inboundMessageId),
  };
}

function configuredToken() {
  const token = String(process.env.PROVIDER_CRM_ACTION_API_TOKEN || "").trim();
  if (!token) {
    throw Object.assign(new Error("Provider WhatsApp action integration is not configured"), {
      status: 503,
      code: "PROVIDER_ACTION_NOT_CONFIGURED",
    });
  }
  return token;
}

function authorized(req, res, next) {
  const context = actionContext(req);
  req.internalActor = {
    type: "crm_whatsapp_action",
    providerId: context.providerId,
  };
  console.info({ event: "provider_whatsapp_action_received", ...context });

  try {
    const match = String(req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    const supplied = String(match?.[1] || "").trim();
    const expected = configuredToken();
    const suppliedHash = crypto.createHash("sha256").update(supplied, "utf8").digest();
    const expectedHash = crypto.createHash("sha256").update(expected, "utf8").digest();
    if (!supplied || !crypto.timingSafeEqual(suppliedHash, expectedHash)) {
      console.warn({
        event: "provider_whatsapp_action_auth_failed",
        ...context,
        suppliedCredentialFingerprint: credentialFingerprint(supplied),
        configuredCredentialFingerprint: credentialFingerprint(expected),
      });
      return res.status(401).json({
        success: false,
        code: "PROVIDER_ACTION_UNAUTHORIZED",
        message: "Unauthorized",
        requestId: req.requestId,
      });
    }
    return next();
  } catch (error) {
    console.error({
      event: "provider_whatsapp_action_processing_failed",
      ...context,
      stage: "authentication_configuration",
      status: Number(error.status || 500),
      code: error.code || "PROVIDER_ACTION_AUTH_CONFIGURATION_FAILED",
      configuredCredentialFingerprint: credentialFingerprint(
        process.env.PROVIDER_CRM_ACTION_API_TOKEN,
      ),
    });
    return next(error);
  }
}

router.post("/lead-unlock", authorized, controller.viewEnquiry);

module.exports = router;
module.exports.actionContext = actionContext;
module.exports.authorized = authorized;
module.exports.configuredToken = configuredToken;
module.exports.credentialFingerprint = credentialFingerprint;
