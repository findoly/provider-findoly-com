const Provider = require("../models/Provider");
const {
  providerQuery,
  ensureProviderEligible,
} = require("../utils/provider");
const {
  COOKIE_NAME,
  clearCookieOptions,
  verifySessionToken,
} = require("../utils/session");

function clearSession(res) {
  res.clearCookie(COOKIE_NAME, clearCookieOptions());
}

async function attachProvider(req, res, next) {
  req.provider = null;
  req.authFailure = null;

  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next();

  try {
    const payload = verifySessionToken(token);
    const record = await Provider.findOne(providerQuery(payload.sub)).lean();
    req.provider = ensureProviderEligible(record);
    req.sessionPayload = payload;
    return next();
  } catch (error) {
    clearSession(res);
    req.authFailure = {
      status: Number(error.status || 401),
      code: error.code || "SESSION_INVALID",
      message:
        Number(error.status) === 403
          ? error.message
          : "Your provider session is no longer valid",
    };
    return next();
  }
}

function safeReturnTo(value, fallback = "/dashboard") {
  const target = String(value || "");
  if (!target.startsWith("/") || target.startsWith("//")) return fallback;
  if (target.startsWith("/login") || target.startsWith("/api")) return fallback;
  return target;
}

function pageAuth(req, res, next) {
  if (req.provider?.providerId) return next();
  const returnTo = safeReturnTo(req.originalUrl || "/dashboard");
  const reason = req.authFailure?.code
    ? `&reason=${encodeURIComponent(req.authFailure.code)}`
    : "";
  return res.redirect(
    `/login?returnTo=${encodeURIComponent(returnTo)}${reason}`,
  );
}

function guestOnly(req, res, next) {
  if (req.provider?.providerId) return res.redirect("/dashboard");
  return next();
}

function apiAuth(req, res, next) {
  if (req.provider?.providerId) return next();
  const failure = req.authFailure || {};
  return res.status(failure.status || 401).json({
    success: false,
    code: failure.code || "AUTHENTICATION_REQUIRED",
    message: failure.message || "Authentication required",
  });
}

module.exports = {
  attachProvider,
  pageAuth,
  guestOnly,
  apiAuth,
  safeReturnTo,
};
