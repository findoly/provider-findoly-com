const crypto = require("crypto");

const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME || "provider_csrf";

function cookieOptions(httpOnly) {
  return {
    httpOnly,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 24 * 60 * 60 * 1000,
  };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function ensureCsrfToken(req, res, next) {
  let token = req.cookies?.[CSRF_COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    token = crypto.randomBytes(32).toString("hex");
    res.cookie(CSRF_COOKIE, token, cookieOptions(false));
  }
  res.locals.csrfToken = token;
  return next();
}

function verifyCsrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get("x-csrf-token");
  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    return res.status(403).json({
      success: false,
      code: "CSRF_INVALID",
      message: "Your session security token expired. Refresh the page and try again.",
    });
  }

  const origin = req.get("origin");
  if (origin) {
    let expected;
    try {
      expected = `${req.protocol}://${req.get("host")}`;
    } catch (error) {
      expected = "";
    }
    console.log("orgin", origin)
    console.log("expected", expected);
    if (origin !== expected) {
      return res.status(403).json({
        success: false,
        code: "ORIGIN_INVALID",
        message: "Request origin is not allowed",
      });
    }
  }

  return next();
}

module.exports = { ensureCsrfToken, verifyCsrf, CSRF_COOKIE };
