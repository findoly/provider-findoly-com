"use strict";

function present(value) {
  return Boolean(String(value || "").trim());
}

function requireProduction(name, condition = true) {
  if (process.env.NODE_ENV === "production" && condition && !present(process.env[name])) {
    throw new Error(`${name} is required in production`);
  }
}

function databaseNameFromMongoUri(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["mongodb:", "mongodb+srv:"].includes(url.protocol)) return "";
    return decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0] || "").trim();
  } catch (_error) {
    return "";
  }
}

function strongSecret(value, minimum = 32) {
  const text = String(value || "").trim();
  return text.length >= minimum && !/(replace|placeholder|example|dummy|change-provider-secret|your[_ -]?secret)/i.test(text);
}

function integerFromEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a whole number between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function validateEnvironment() {
  const production = process.env.NODE_ENV === "production";
  requireProduction("MONGODB_URI");
  requireProduction("JWT_SECRET");

  if (present(process.env.MONGODB_URI)) {
    const databaseName = databaseNameFromMongoUri(process.env.MONGODB_URI);
    if (!databaseName) throw new Error("MONGODB_URI must include an explicit database name");
    const expected = String(process.env.PROVIDER_EXPECTED_DATABASE_NAME || "").trim();
    if (expected && databaseName !== expected) {
      throw new Error(`MONGODB_URI database must match PROVIDER_EXPECTED_DATABASE_NAME (${expected})`);
    }
  }

  if (production && !strongSecret(process.env.JWT_SECRET, 32)) {
    throw new Error("JWT_SECRET must be a strong production secret of at least 32 characters");
  }
  if (production && String(process.env.MONGO_AUTO_INDEX || "").trim().toLowerCase() === "true") {
    throw new Error("MONGO_AUTO_INDEX must remain false in production; run npm run ensure:indexes during deployment");
  }

  integerFromEnv("PROVIDER_QUERY_MAX_TIME_MS", 10000, 1000, 60000);
  integerFromEnv("MONGO_SERVER_SELECTION_TIMEOUT_MS", 10000, 1000, 120000);
  integerFromEnv("MONGO_MAX_POOL_SIZE", 30, 1, 500);
  integerFromEnv("MONGO_MIN_POOL_SIZE", 2, 0, 100);
  integerFromEnv("MONGO_MAX_IDLE_TIME_MS", 60000, 1000, 600000);

  const otpUrls = [
    process.env.PROVIDER_OTP_BASE_URL,
    process.env.PROVIDER_OTP_SEND_URL,
    process.env.PROVIDER_OTP_VERIFY_URL,
    process.env.OTP_API_URL,
  ].filter(Boolean);
  if (production && otpUrls.some((value) => !String(value).startsWith("https://"))) {
    throw new Error("Provider OTP service URLs must use HTTPS in production");
  }

  const hasRazorpayKey = Boolean(process.env.RAZORPAY_KEY_ID);
  const hasRazorpaySecret = Boolean(process.env.RAZORPAY_KEY_SECRET);
  if (hasRazorpayKey !== hasRazorpaySecret) {
    throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be configured together");
  }
  if (production && hasRazorpayKey && !process.env.RAZORPAY_WEBHOOK_SECRET) {
    throw new Error("RAZORPAY_WEBHOOK_SECRET is required when Razorpay is enabled in production");
  }
}

function numberFromEnv(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name]);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

module.exports = {
  validateEnvironment,
  numberFromEnv,
  databaseNameFromMongoUri,
  strongSecret,
};
