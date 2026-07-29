const { fetchJson } = require("../../utils/http");

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

const OTP_SERVICE_BASE_URL = trimTrailingSlash(
  process.env.PROVIDER_OTP_BASE_URL
    || process.env.OTP_API_URL
    || "https://api.findoly.com/otp",
);

function endpointUrl(explicitUrl, legacyPath, endpointName) {
  if (explicitUrl) return String(explicitUrl);
  if (legacyPath) {
    let path = String(legacyPath).startsWith("/") ? String(legacyPath) : `/${legacyPath}`;
    if (OTP_SERVICE_BASE_URL.endsWith("/otp") && path.startsWith("/otp/")) {
      path = path.slice(4);
    }
    return `${OTP_SERVICE_BASE_URL}${path}`;
  }
  return OTP_SERVICE_BASE_URL.endsWith("/otp")
    ? `${OTP_SERVICE_BASE_URL}/${endpointName}`
    : `${OTP_SERVICE_BASE_URL}/otp/${endpointName}`;
}

const SEND_OTP_URL = endpointUrl(
  process.env.PROVIDER_OTP_SEND_URL,
  process.env.OTP_SEND_PATH,
  "send-otp",
);
const VERIFY_OTP_URL = endpointUrl(
  process.env.PROVIDER_OTP_VERIFY_URL,
  process.env.OTP_VERIFY_PATH,
  "verify-otp",
);
const REQUEST_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.PROVIDER_OTP_REQUEST_TIMEOUT_MS || process.env.OTP_TIMEOUT_MS || 12000) || 12000, 1000),
  60000,
);

function otpHeaders() {
  const headers = { "Content-Type": "application/json" };
  const token = process.env.PROVIDER_OTP_API_TOKEN || process.env.OTP_API_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function requestOtpApi(url, payload) {
  let result;
  try {
    result = await fetchJson(url, {
      method: "POST",
      headers: otpHeaders(),
      body: JSON.stringify(payload),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    if (Number(error?.status) === 504) {
      throw Object.assign(new Error("OTP service did not respond in time"), {
        status: 504,
        requestMayHaveSucceeded: Boolean(error?.requestMayHaveSucceeded),
        cause: error,
      });
    }
    throw Object.assign(new Error("Unable to connect to the OTP service"), {
      status: 502,
      requestMayHaveSucceeded: Boolean(error?.requestMayHaveSucceeded),
      cause: error,
    });
  }

  const { response, body } = result;
  const upstreamStatus = String(
    body?.status || body?.data?.status || body?.result?.status || "",
  ).trim().toLowerCase();
  const explicitlyFailed = body?.success === false
    || body?.data?.success === false
    || ["error", "failed", "fail", "rejected", "invalid"].includes(upstreamStatus);

  if (!response.ok || explicitlyFailed) {
    const rawRetryAfter = body?.retryAfterSeconds
      || body?.retryAfter
      || body?.data?.retryAfterSeconds
      || response.headers.get("retry-after");
    const retryAfterSeconds = Number.isFinite(Number(rawRetryAfter))
      ? Math.max(1, Math.ceil(Number(rawRetryAfter)))
      : 0;
    let message = body?.message
      || body?.error
      || body?.data?.message
      || body?.result?.message
      || `OTP service request failed with status ${response.status}`;

    if (response.status === 429 && retryAfterSeconds > 0 && !/wait|second|minute/i.test(message)) {
      message = `Too many OTP requests. Please wait ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"} and try again.`;
    }

    const status = response.status === 429
      ? 429
      : response.status >= 400 && response.status < 500
        ? 400
        : 502;

    throw Object.assign(new Error(String(message).slice(0, 1000)), {
      status,
      retryAfterSeconds,
      upstreamStatusCode: response.status,
      upstreamCode: body?.code || body?.data?.code || "",
      requestMayHaveSucceeded: response.status >= 500,
    });
  }

  return body;
}

module.exports = {
  requestOtpApi,
  OTP_SERVICE_BASE_URL,
  SEND_OTP_URL,
  VERIFY_OTP_URL,
  REQUEST_TIMEOUT_MS,
};
