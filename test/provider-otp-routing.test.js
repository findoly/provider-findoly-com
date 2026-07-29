const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

for (const name of [
  "PROVIDER_OTP_BASE_URL",
  "PROVIDER_OTP_SEND_URL",
  "PROVIDER_OTP_VERIFY_URL",
  "OTP_API_URL",
  "OTP_SEND_PATH",
  "OTP_VERIFY_PATH",
]) delete process.env[name];

const otpClient = require("../services/access/otp-proxy-client");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("provider server-side OTP endpoints default to the Findoly OTP namespace", () => {
  assert.equal(otpClient.OTP_SERVICE_BASE_URL, "https://api.findoly.com/otp");
  assert.equal(otpClient.SEND_OTP_URL, "https://api.findoly.com/otp/send-otp");
  assert.equal(otpClient.VERIFY_OTP_URL, "https://api.findoly.com/otp/verify-otp");
});

test("provider login browser calls only same-origin auth routes", () => {
  const source = read("views/auth/login.ejs");
  assert.match(source, /apiFetch\('\/api\/auth\/send-otp'/);
  assert.match(source, /apiFetch\('\/api\/auth\/verify-otp'/);
  assert.doesNotMatch(source, /api\.findoly\.com/);
  assert.doesNotMatch(source, /localhost:\d+/);
});

test("provider authentication has no fixed or exposed development OTP", () => {
  const source = [
    read("services/auth/auth-service.js"),
    read("controllers/authController.js"),
    read("views/auth/login.ejs"),
  ].join("\n");
  assert.doesNotMatch(source, /devOtp|DEV_OTP_CODE|Development OTP|123456/);
  assert.match(source, /requestOtpApi\(SEND_OTP_URL/);
  assert.match(source, /requestOtpApi\(VERIFY_OTP_URL/);
});

test("provider OTP configuration requires HTTPS overrides in production", () => {
  const source = read("config/env.js");
  assert.match(source, /Provider OTP service URLs must use HTTPS in production/);
  assert.doesNotMatch(source, /requireProduction\("OTP_API_URL"\)/);
});
