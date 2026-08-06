"use strict";

const crypto = require("crypto");
const express = require("express");
const controller = require("../controllers/internalWhatsappController");

const router = express.Router();

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
  try {
    const match = String(req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    const supplied = String(match?.[1] || "").trim();
    const expected = configuredToken();
    const suppliedHash = crypto.createHash("sha256").update(supplied, "utf8").digest();
    const expectedHash = crypto.createHash("sha256").update(expected, "utf8").digest();
    if (!supplied || !crypto.timingSafeEqual(suppliedHash, expectedHash)) {
      return res.status(401).json({
        success: false,
        code: "PROVIDER_ACTION_UNAUTHORIZED",
        message: "Unauthorized",
        requestId: req.requestId,
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

router.post("/lead-unlock", authorized, controller.viewEnquiry);

module.exports = router;
module.exports.authorized = authorized;
module.exports.configuredToken = configuredToken;
