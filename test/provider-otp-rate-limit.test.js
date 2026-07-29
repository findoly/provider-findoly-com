const test = require("node:test");
const assert = require("node:assert/strict");

process.env.PROVIDER_OTP_RESEND_SECONDS = "30";
process.env.PROVIDER_OTP_MAX_SENDS_PER_WINDOW = "2";
process.env.PROVIDER_OTP_RATE_WINDOW_SECONDS = "60";

const {
  settings,
  rateLimitDecision,
  rateLimitError,
} = require("../services/access/otp-rate-limit-service");

test("provider OTP policy allows two sends per minute with a 30-second wait", () => {
  assert.deepEqual(settings(), {
    resendSeconds: 30,
    maxSendsPerWindow: 2,
    windowSeconds: 60,
  });
});

test("first provider OTP send is allowed", () => {
  const now = new Date("2026-07-29T10:00:00.000Z");
  const decision = rateLimitDecision(null, now, settings());
  assert.equal(decision.allowed, true);
  assert.equal(decision.nextCount, 1);
});

test("provider OTP resend returns the exact remaining wait", () => {
  const now = new Date("2026-07-29T10:00:10.000Z");
  const decision = rateLimitDecision({
    windowStartedAt: new Date("2026-07-29T10:00:00.000Z"),
    sendCount: 1,
    nextAllowedAt: new Date("2026-07-29T10:00:30.000Z"),
  }, now, settings());
  assert.equal(decision.allowed, false);
  assert.equal(decision.waitSeconds, 20);
});

test("third provider OTP send waits for the current window to reset", () => {
  const now = new Date("2026-07-29T10:00:45.000Z");
  const decision = rateLimitDecision({
    windowStartedAt: new Date("2026-07-29T10:00:00.000Z"),
    sendCount: 2,
    nextAllowedAt: new Date("2026-07-29T10:00:40.000Z"),
  }, now, settings());
  assert.equal(decision.allowed, false);
  assert.equal(decision.waitSeconds, 15);
});

test("provider rate-limit response explains the resend wait", () => {
  const error = rateLimitError(17);
  assert.equal(error.status, 429);
  assert.equal(error.code, "PROVIDER_OTP_SEND_RATE_LIMIT");
  assert.equal(error.retryAfterSeconds, 17);
  assert.match(error.message, /wait 17 seconds/i);
});
