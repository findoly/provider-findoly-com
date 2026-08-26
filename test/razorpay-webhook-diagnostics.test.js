"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  FINGERPRINT_LENGTH,
  buildRazorpayWebhookDiagnostic,
  logRazorpayWebhookDiagnostic,
} = require("../services/wallet/razorpay-webhook-diagnostics");

test("Razorpay webhook diagnostic logs only safe secret metadata", () => {
  const secret = "test-webhook-secret-that-must-never-be-logged";
  const signature = "a".repeat(64);
  const requestId = "req-webhook-diagnostic";
  let logged;
  const originalInfo = console.info;

  try {
    console.info = (entry) => {
      logged = entry;
    };
    logRazorpayWebhookDiagnostic({ requestId, signature, secret });
  } finally {
    console.info = originalInfo;
  }

  const expectedFingerprint = crypto
    .createHash("sha256")
    .update(secret, "utf8")
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);

  assert.deepEqual(logged, {
    event: "razorpay_webhook_signature_diagnostic",
    requestId,
    webhookSecretConfigured: true,
    webhookSecretLength: secret.length,
    webhookSecretFingerprint: expectedFingerprint,
    signaturePresent: true,
    signatureLength: signature.length,
  });
  assert.equal(JSON.stringify(logged).includes(secret), false);
});

test("Razorpay webhook diagnostic exposes no fingerprint when secret is absent", () => {
  const diagnostic = buildRazorpayWebhookDiagnostic({
    requestId: "req-no-secret",
    signature: "",
    secret: "",
  });

  assert.equal(diagnostic.webhookSecretConfigured, false);
  assert.equal(diagnostic.webhookSecretLength, 0);
  assert.equal(diagnostic.webhookSecretFingerprint, "");
  assert.equal(diagnostic.signaturePresent, false);
  assert.equal(diagnostic.signatureLength, 0);
});
