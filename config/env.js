function requireProduction(name, condition = true) {
  if (process.env.NODE_ENV === "production" && condition && !process.env[name]) {
    throw new Error(`${name} is required in production`);
  }
}

function validateEnvironment() {
  requireProduction("MONGODB_URI");
  requireProduction("JWT_SECRET");
  requireProduction("OTP_API_URL");

  if (
    process.env.NODE_ENV === "production" &&
    ["change-provider-secret", "replace-with-a-long-random-secret"].includes(
      process.env.JWT_SECRET,
    )
  ) {
    throw new Error("JWT_SECRET must be replaced with a strong production secret");
  }

  const hasRazorpayKey = Boolean(process.env.RAZORPAY_KEY_ID);
  const hasRazorpaySecret = Boolean(process.env.RAZORPAY_KEY_SECRET);
  if (hasRazorpayKey !== hasRazorpaySecret) {
    throw new Error(
      "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be configured together",
    );
  }

  if (
    process.env.NODE_ENV === "production" &&
    hasRazorpayKey &&
    !process.env.RAZORPAY_WEBHOOK_SECRET
  ) {
    throw new Error(
      "RAZORPAY_WEBHOOK_SECRET is required when Razorpay is enabled in production",
    );
  }
}

function numberFromEnv(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name]);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

module.exports = { validateEnvironment, numberFromEnv };
