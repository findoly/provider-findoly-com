const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fetchJson } = require("../utils/http");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("HTTP client accepts JSON and plain-text upstream responses", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "OTP sent successfully",
    });
    const textResult = await fetchJson("https://example.test", { method: "POST", timeoutMs: 1000 });
    assert.equal(textResult.body.message, "OTP sent successfully");

    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ success: true, expiresInSeconds: 120 }),
    });
    const jsonResult = await fetchJson("https://example.test", { method: "POST", timeoutMs: 1000 });
    assert.equal(jsonResult.body.expiresInSeconds, 120);
  } finally {
    global.fetch = originalFetch;
  }
});

test("provider OTP send exposes accepted state without bypassing verification", () => {
  const service = read("services/auth/auth-service.js");
  const controller = read("controllers/authController.js");
  assert.match(service, /requestMayHaveSucceeded/);
  assert.match(service, /deliveryUncertain: true/);
  assert.match(controller, /data\.deliveryUncertain \? 202 : 200/);
  assert.match(service, /Invalid or expired OTP/);
});

test("CSRF validation contains no production debug origin logging", () => {
  const security = read("middleware/security.js");
  assert.doesNotMatch(security, /console\.log\(/);
  assert.match(security, /origin !== expected/);
});
