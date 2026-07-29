const service = require("../services/auth/auth-service");
const {
  COOKIE_NAME,
  cookieOptions,
  clearCookieOptions,
  createSessionToken,
} = require("../utils/session");

async function sendOtp(req, res, next) {
  try {
    const data = await service.sendOtp(req.body?.mobile);
    return res.status(data.deliveryUncertain ? 202 : 200).json({ success: true, data });
  } catch (error) {
    if (error?.code === "PROVIDER_OTP_SEND_RATE_LIMIT") {
      res.set("Retry-After", String(error.retryAfterSeconds));
      return res.status(429).json({
        success: false,
        code: "OTP_RESEND_WAIT",
        message: error.message,
        retryAfterSeconds: error.retryAfterSeconds,
      });
    }

    if (error?.status === 429) {
      const retryAfterSeconds = Number(error.retryAfterSeconds || 0);
      if (retryAfterSeconds > 0) res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        success: false,
        code: "OTP_SERVICE_RATE_LIMIT",
        message: error.message || "The OTP service has temporarily limited requests. Please try again shortly.",
        ...(retryAfterSeconds > 0 ? { retryAfterSeconds } : {}),
      });
    }

    if ([502, 504].includes(Number(error?.status))) {
      return res.status(503).json({
        success: false,
        code: "OTP_SERVICE_UNAVAILABLE",
        message: Number(error.status) === 504
          ? "The OTP service took too long to respond. Please try again."
          : "We could not send an OTP because the OTP service is temporarily unavailable. Please try again shortly.",
      });
    }

    return next(error);
  }
}

async function verifyOtp(req, res, next) {
  try {
    const provider = await service.verifyOtp(req.body?.mobile, req.body?.otp);
    res.cookie(
      COOKIE_NAME,
      createSessionToken(provider.providerId),
      cookieOptions(),
    );
    return res.json({ success: true, data: provider });
  } catch (error) {
    if (error?.status === 429) {
      const retryAfterSeconds = Number(error.retryAfterSeconds || 0);
      if (retryAfterSeconds > 0) res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        success: false,
        code: "OTP_VERIFICATION_RESTRICTED",
        message: error.message || "OTP verification is temporarily restricted. Please try again later.",
        ...(retryAfterSeconds > 0 ? { retryAfterSeconds } : {}),
      });
    }

    if ([502, 504].includes(Number(error?.status))) {
      return res.status(503).json({
        success: false,
        code: "OTP_SERVICE_UNAVAILABLE",
        message: Number(error.status) === 504
          ? "The OTP service took too long to verify your code. Please try again."
          : "We could not verify your OTP because the OTP service is temporarily unavailable. Please try again shortly.",
      });
    }

    return next(error);
  }
}

function logout(req, res) {
  res.clearCookie(COOKIE_NAME, clearCookieOptions());
  return res.json({ success: true });
}

module.exports = { sendOtp, verifyOtp, logout };
