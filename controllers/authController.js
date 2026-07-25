const service = require("../services/auth/auth-service");
const {
  COOKIE_NAME,
  cookieOptions,
  clearCookieOptions,
  createSessionToken,
} = require("../utils/session");

async function sendOtp(req, res, next) {
  try {
    const data = await service.sendOtp(req.body.mobile);
    return res.status(data.deliveryUncertain ? 202 : 200).json({
      success: true,
      data,
    });
  } catch (error) {
    return next(error);
  }
}

async function verifyOtp(req, res, next) {
  try {
    const provider = await service.verifyOtp(req.body.mobile, req.body.otp);
    res.cookie(
      COOKIE_NAME,
      createSessionToken(provider.providerId),
      cookieOptions(),
    );
    return res.json({ success: true, data: provider });
  } catch (error) {
    return next(error);
  }
}

function logout(req, res) {
  res.clearCookie(COOKIE_NAME, clearCookieOptions());
  return res.json({ success: true });
}

module.exports = { sendOtp, verifyOtp, logout };
