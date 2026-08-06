const { rateLimit } = require("express-rate-limit");

function jsonHandler(message) {
  return (req, res) =>
    res.status(429).json({
      success: false,
      code: "RATE_LIMITED",
      message,
    });
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT_PER_MINUTE || 180),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: jsonHandler("Too many requests. Please wait a moment."),
});

const sendOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.OTP_SEND_LIMIT || 5),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: jsonHandler("Too many OTP requests. Try again later."),
});

const verifyOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.OTP_VERIFY_LIMIT || 10),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: jsonHandler("Too many OTP attempts. Try again later."),
});


const providerJoinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Math.min(50, Math.max(1, Number(process.env.PROVIDER_JOIN_REQUEST_LIMIT_PER_HOUR) || 5)),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: jsonHandler("Too many joining requests. Please wait before trying again."),
});

const walletLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.WALLET_RATE_LIMIT_PER_MINUTE || 20),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: jsonHandler("Too many payment requests. Please wait a moment."),
});

const internalWhatsappLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.PROVIDER_WHATSAPP_ACTION_RATE_LIMIT_PER_MINUTE || 120),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: jsonHandler("Too many WhatsApp action requests. Please wait a moment."),
});

const unlockLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.UNLOCK_RATE_LIMIT_PER_MINUTE || 20),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: jsonHandler("Too many unlock attempts. Please wait a moment."),
});

module.exports = {
  apiLimiter,
  sendOtpLimiter,
  verifyOtpLimiter,
  walletLimiter,
  unlockLimiter,
  providerJoinLimiter,
  internalWhatsappLimiter,
};
