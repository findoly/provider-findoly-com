const Provider = require("../../models/Provider");
const { normalizeMobile } = require("../../utils/mobile");
const { fetchJson } = require("../../utils/http");
const {
  ensureProviderEligible,
  presentProvider,
  providerIdentity,
  providerQuery,
} = require("../../utils/provider");

function mobilePattern(mobile) {
  const digits = String(mobile).split("").join("\\D*");
  return new RegExp(`${digits}$`);
}

async function findProvider(mobileInput) {
  const mobile = normalizeMobile(mobileInput);
  if (mobile.length !== 10) return null;

  const provider = await Provider.findOne({
    $or: [
      { normalizedMobile: mobile },
      { mobile },
      { mobile: `+91${mobile}` },
      { mobile: mobilePattern(mobile) },
    ],
  })
    .sort({ status: 1, portalAccessEnabled: -1, updatedAt: -1 })
    .lean();

  return provider;
}

function otpHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (process.env.OTP_API_TOKEN) {
    headers.Authorization = `Bearer ${process.env.OTP_API_TOKEN}`;
  }
  return headers;
}

async function sendOtp(mobileInput) {
  const mobile = normalizeMobile(mobileInput);
  if (mobile.length !== 10) {
    throw Object.assign(new Error("Enter a valid 10-digit mobile number"), {
      status: 400,
      code: "MOBILE_INVALID",
    });
  }

  ensureProviderEligible(await findProvider(mobile));

  if (!process.env.OTP_API_URL) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("OTP service is not configured"), {
        status: 503,
        code: "OTP_NOT_CONFIGURED",
      });
    }

    return {
      mobile,
      devOtp: process.env.DEV_OTP_CODE || "123456",
      expiresInSeconds: 300,
    };
  }

  try {
    const { response, body } = await fetchJson(
      `${process.env.OTP_API_URL}${process.env.OTP_SEND_PATH || "/otp/send-otp"}`,
      {
        method: "POST",
        headers: otpHeaders(),
        body: JSON.stringify({ mobile }),
        timeoutMs: Number(process.env.OTP_TIMEOUT_MS || 10000),
      },
    );

    const upstreamStatus = String(
      body?.status || body?.data?.status || body?.result?.status || "",
    ).trim().toLowerCase();
    const explicitlyFailed = body?.success === false
      || body?.data?.success === false
      || ["error", "failed", "fail", "rejected", "invalid"].includes(upstreamStatus);

    if (!response.ok || explicitlyFailed) {
      const error = Object.assign(
        new Error(body?.message || body?.error || body?.data?.message || "OTP service could not send the code"),
        {
          status: response.status === 429 ? 429 : 502,
          code: response.status === 429 ? "OTP_RATE_LIMITED" : "OTP_SEND_FAILED",
          requestMayHaveSucceeded: response.status >= 500,
        },
      );
      throw error;
    }

    return {
      mobile,
      expiresInSeconds: Number(body?.expiresInSeconds || body?.data?.expiresInSeconds || 300),
      deliveryStatus: "sent",
      deliveryUncertain: false,
    };
  } catch (error) {
    if (error?.requestMayHaveSucceeded) {
      return {
        mobile,
        expiresInSeconds: 300,
        deliveryStatus: "accepted",
        deliveryUncertain: true,
        message: "The OTP request was accepted. Enter the code if it arrives, or request another code after the timer ends.",
      };
    }
    throw error;
  }
}

async function verifyOtp(mobileInput, otpInput) {
  const mobile = normalizeMobile(mobileInput);
  const otp = String(otpInput || "").trim();

  if (mobile.length !== 10 || !/^\d{4,8}$/.test(otp)) {
    throw Object.assign(new Error("Enter a valid mobile number and OTP"), {
      status: 400,
      code: "OTP_INPUT_INVALID",
    });
  }

  let verified = false;
  if (process.env.OTP_API_URL) {
    const { response, body } = await fetchJson(
      `${process.env.OTP_API_URL}${process.env.OTP_VERIFY_PATH || "/otp/verify-otp"}`,
      {
        method: "POST",
        headers: otpHeaders(),
        body: JSON.stringify({ mobile, otp }),
        timeoutMs: Number(process.env.OTP_TIMEOUT_MS || 10000),
      },
    );
    verified =
      response.ok &&
      body.success !== false &&
      Boolean(body.verified ?? body.verify ?? body.success);
  } else if (process.env.NODE_ENV !== "production") {
    verified = otp === (process.env.DEV_OTP_CODE || "123456");
  }

  if (!verified) {
    throw Object.assign(new Error("Invalid or expired OTP"), {
      status: 401,
      code: "OTP_INVALID",
    });
  }

  const provider = ensureProviderEligible(await findProvider(mobile));
  const providerId = providerIdentity(provider);

  await Provider.updateOne(providerQuery(providerId), {
    $set: {
      providerId,
      normalizedMobile: mobile,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    },
  });

  return presentProvider({ ...provider, providerId, lastLoginAt: new Date() });
}

module.exports = { sendOtp, verifyOtp, findProvider };
