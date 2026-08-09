const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "provider_auth";
const DEFAULT_SESSION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function sessionDurationDays() {
  return Number(process.env.AUTH_COOKIE_DAYS || DEFAULT_SESSION_DAYS);
}

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required in production");
  }
  return "development-provider-secret-change-me";
}

function cookieOptions() {
  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.AUTH_COOKIE_SAME_SITE || "lax",
    path: "/",
    maxAge: sessionDurationDays() * DAY_MS,
    priority: "high",
  };
  if (process.env.AUTH_COOKIE_DOMAIN) {
    options.domain = process.env.AUTH_COOKIE_DOMAIN;
  }
  return options;
}

function clearCookieOptions() {
  const { maxAge, ...options } = cookieOptions();
  return options;
}

function createSessionToken(providerId) {
  return jwt.sign(
    {
      sub: providerId,
      type: "provider",
      jti: crypto.randomUUID(),
    },
    jwtSecret(),
    {
      algorithm: "HS256",
      expiresIn: `${sessionDurationDays()}d`,
      issuer: process.env.JWT_ISSUER || "provider-lead-portal",
      audience: process.env.JWT_AUDIENCE || "provider-portal-browser",
    },
  );
}

function verifySessionToken(token) {
  const payload = jwt.verify(token, jwtSecret(), {
    algorithms: ["HS256"],
    issuer: process.env.JWT_ISSUER || "provider-lead-portal",
    audience: process.env.JWT_AUDIENCE || "provider-portal-browser",
  });

  if (payload?.type !== "provider" || !payload?.sub) {
    throw new Error("Invalid provider session");
  }

  return payload;
}

module.exports = {
  COOKIE_NAME,
  cookieOptions,
  clearCookieOptions,
  createSessionToken,
  verifySessionToken,
};
