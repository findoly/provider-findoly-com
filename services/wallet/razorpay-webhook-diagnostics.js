"use strict";

const crypto = require("node:crypto");

const FINGERPRINT_LENGTH = 12;

function stringValue(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function buildRazorpayWebhookDiagnostic({
  requestId = "",
  signature = "",
  secret = process.env.RAZORPAY_WEBHOOK_SECRET,
} = {}) {
  const secretValue = stringValue(secret);
  const signatureValue = stringValue(signature);

  return {
    event: "razorpay_webhook_signature_diagnostic",
    requestId: stringValue(requestId),
    webhookSecretConfigured: secretValue.length > 0,
    webhookSecretLength: secretValue.length,
    webhookSecretFingerprint: secretValue
      ? crypto
        .createHash("sha256")
        .update(secretValue, "utf8")
        .digest("hex")
        .slice(0, FINGERPRINT_LENGTH)
      : "",
    signaturePresent: signatureValue.length > 0,
    signatureLength: signatureValue.length,
  };
}

function logRazorpayWebhookDiagnostic(input = {}) {
  const diagnostic = buildRazorpayWebhookDiagnostic(input);
  console.info(diagnostic);
  return diagnostic;
}

module.exports = {
  FINGERPRINT_LENGTH,
  buildRazorpayWebhookDiagnostic,
  logRazorpayWebhookDiagnostic,
};
