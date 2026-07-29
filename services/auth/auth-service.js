const Provider = require("../../models/Provider");
const { normalizeMobile } = require("../../utils/mobile");
const {
  ensureProviderEligible,
  presentProvider,
  providerIdentity,
  providerQuery,
} = require("../../utils/provider");
const {
  requestOtpApi,
  SEND_OTP_URL,
  VERIFY_OTP_URL,
} = require("../access/otp-proxy-client");
const {
  claimSendSlot,
  releaseSendSlot,
} = require("../access/otp-rate-limit-service");

function mobilePattern(mobile) {
  const digits = String(mobile).split("").join("\\D*");
  return new RegExp(`${digits}$`);
}

function providerMobile(value, label = "Mobile number") {
  const mobile = normalizeMobile(value);
  if (!/^[6-9]\d{9}$/.test(mobile)) {
    throw Object.assign(new Error(`${label} must be a valid 10-digit Indian mobile number`), {
      status: 400,
      code: "MOBILE_INVALID",
    });
  }
  return mobile;
}

async function findProvider(mobileInput) {
  const mobile = normalizeMobile(mobileInput);
  if (mobile.length !== 10) return null;

  return Provider.findOne({
    $or: [
      { normalizedMobile: mobile },
      { mobile },
      { mobile: `+91${mobile}` },
      { mobile: mobilePattern(mobile) },
    ],
  })
    .sort({ status: 1, portalAccessEnabled: -1, updatedAt: -1 })
    .lean();
}

async function assertLoginAllowed(mobile) {
  return ensureProviderEligible(await findProvider(mobile));
}

async function sendOtp(mobileInput) {
  const mobile = providerMobile(mobileInput);
  await assertLoginAllowed(mobile);

  let rateLimitClaim = null;
  try {
    rateLimitClaim = await claimSendSlot(mobile);
    const response = await requestOtpApi(SEND_OTP_URL, { mobile });
    return {
      mobile,
      sessionId: response?.data?.sessionId || response?.sessionId || "",
      message: response?.data?.message || response?.message || "OTP sent successfully",
      expiresInSeconds: Number(response?.data?.expiresInSeconds || response?.expiresInSeconds || 300),
      retryAfterSeconds: rateLimitClaim.retryAfterSeconds,
      deliveryStatus: "sent",
      deliveryUncertain: false,
    };
  } catch (error) {
    const deliveryUncertain = [502, 504].includes(Number(error?.status))
      && Boolean(error?.requestMayHaveSucceeded);
    const allowUnconfirmed = String(
      process.env.PROVIDER_OTP_SEND_ALLOW_UNCONFIRMED || "true",
    ).toLowerCase() !== "false";
    if (deliveryUncertain && allowUnconfirmed) {
      return {
        mobile,
        sessionId: "",
        expiresInSeconds: 300,
        retryAfterSeconds: rateLimitClaim?.retryAfterSeconds || Number(process.env.PROVIDER_OTP_RESEND_SECONDS || 30),
        deliveryStatus: "accepted",
        deliveryUncertain: true,
        message: "OTP request submitted. Enter the code if it arrives; otherwise retry after the resend wait.",
      };
    }
    if (rateLimitClaim && error?.code !== "PROVIDER_OTP_SEND_RATE_LIMIT") {
      await releaseSendSlot(mobile, rateLimitClaim.requestId).catch(() => {});
    }
    throw error;
  }
}

async function verifyOtp(mobileInput, otpInput) {
  const mobile = providerMobile(mobileInput);
  const otp = String(otpInput || "").trim();

  if (!/^\d{4,8}$/.test(otp)) {
    throw Object.assign(new Error("OTP must contain 4 to 8 digits"), {
      status: 400,
      code: "OTP_INPUT_INVALID",
    });
  }

  await assertLoginAllowed(mobile);
  try {
    const verification = await requestOtpApi(VERIFY_OTP_URL, { mobile, otp });
    const explicitVerified = verification?.verified
      ?? verification?.verify
      ?? verification?.data?.verified
      ?? verification?.data?.verify;
    if (explicitVerified === false) {
      throw Object.assign(new Error("Invalid or expired OTP"), {
        status: 401,
        code: "OTP_INVALID",
      });
    }
  } catch (error) {
    if (Number(error?.status) === 400 || Number(error?.status) === 401) {
      throw Object.assign(new Error("Invalid or expired OTP"), {
        status: 401,
        code: "OTP_INVALID",
      });
    }
    throw error;
  }

  const provider = ensureProviderEligible(await findProvider(mobile));
  const providerId = providerIdentity(provider);
  const lastLoginAt = new Date();

  await Provider.updateOne(providerQuery(providerId), {
    $set: {
      providerId,
      normalizedMobile: mobile,
      lastLoginAt,
      updatedAt: lastLoginAt,
    },
  });

  return presentProvider({ ...provider, providerId, lastLoginAt });
}

module.exports = {
  sendOtp,
  verifyOtp,
  findProvider,
  providerMobile,
  assertLoginAllowed,
};
