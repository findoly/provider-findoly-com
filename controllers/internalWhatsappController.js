"use strict";

const service = require("../services/lead/whatsapp-action-service");

function safeIdentifier(value, maximum = 128) {
  return String(value || "").replace(/[\0\r\n]/g, "").trim().slice(0, maximum);
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

function elapsedMilliseconds(startedAt) {
  return Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2));
}

async function viewEnquiry(req, res, next) {
  const startedAt = process.hrtime.bigint();
  const context = actionContext(req);
  console.info({
    event: "provider_whatsapp_action_processing_started",
    ...context,
  });

  try {
    const data = await service.processAction(req.body, req.headers, {
      requestId: req.requestId,
    });
    const log = ["internal_error", "transaction_failed"].includes(String(data.status || ""))
      ? console.error
      : console.info;
    log({
      event: "provider_whatsapp_action_processing_completed",
      ...context,
      resultStatus: String(data.status || ""),
      resultCode: String(data.code || ""),
      durationMs: elapsedMilliseconds(startedAt),
    });
    return res.json({ success: true, data });
  } catch (error) {
    const status = Math.min(599, Math.max(400, Number(error.status || error.statusCode || 500)));
    const event = status < 500
      ? "provider_whatsapp_action_validation_failed"
      : "provider_whatsapp_action_processing_failed";
    const log = status < 500 ? console.warn : console.error;
    log({
      event,
      ...context,
      status,
      code: String(error.code || "WHATSAPP_ACTION_FAILED"),
      errorName: String(error.name || "Error"),
      durationMs: elapsedMilliseconds(startedAt),
    });
    return next(error);
  }
}

module.exports = { actionContext, viewEnquiry };
