const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

for (const name of [
  "PROVIDER_OTP_BASE_URL",
  "PROVIDER_OTP_SEND_URL",
  "PROVIDER_OTP_VERIFY_URL",
  "OTP_API_URL",
  "OTP_SEND_PATH",
  "OTP_VERIFY_PATH",
  "RAZORPAY_REVIEW_LOGIN_ENABLED",
]) delete process.env[name];

const otpClient = require("../services/access/otp-proxy-client");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

function loadAuthService({
  provider = {
    providerId: "provider-review",
    mobile: "8693097982",
    normalizedMobile: "8693097982",
    status: "active",
    portalAccessEnabled: true,
  },
  otpHandler = async (url) => (url.includes("verify-otp") ? { verified: true } : { message: "OTP sent successfully" }),
} = {}) {
  const authServicePath = path.join(__dirname, "..", "services", "auth", "auth-service.js");
  const calls = { otp: [], claims: [], releases: [], updates: [] };

  const Provider = {
    findOne() {
      return {
        sort() { return this; },
        async lean() { return provider; },
      };
    },
    async updateOne(...args) {
      calls.updates.push(args);
      return { acknowledged: true };
    },
  };

  function ensureProviderEligible(record) {
    if (!record) {
      throw Object.assign(new Error("Provider account not found"), {
        status: 401,
        code: "PROVIDER_NOT_FOUND",
      });
    }
    if (String(record.status || "").toLowerCase() !== "active") {
      throw Object.assign(new Error("Provider account is inactive"), {
        status: 403,
        code: "PROVIDER_INACTIVE",
      });
    }
    if (record.portalAccessEnabled === false) {
      throw Object.assign(new Error("Provider portal access is disabled"), {
        status: 403,
        code: "PORTAL_ACCESS_DISABLED",
      });
    }
    if (!record.providerId) {
      throw Object.assign(new Error("Provider record is missing its provider identifier"), {
        status: 409,
        code: "PROVIDER_ID_MISSING",
      });
    }
    return { ...record };
  }

  const mocks = {
    "../../models/Provider": Provider,
    "../../utils/mobile": {
      normalizeMobile(value) {
        return String(value || "").replace(/\D/g, "").slice(-10);
      },
    },
    "../../utils/provider": {
      ensureProviderEligible,
      presentProvider(record) { return { ...record }; },
      providerIdentity(record) { return String(record?.providerId || ""); },
      providerQuery(providerId) { return { providerId }; },
    },
    "../access/otp-proxy-client": {
      SEND_OTP_URL: "https://api.findoly.com/otp/send-otp",
      VERIFY_OTP_URL: "https://api.findoly.com/otp/verify-otp",
      async requestOtpApi(url, payload) {
        calls.otp.push({ url, payload });
        return otpHandler(url, payload);
      },
    },
    "../access/otp-rate-limit-service": {
      async claimSendSlot(mobile) {
        calls.claims.push(mobile);
        return { requestId: "review-request", retryAfterSeconds: 30 };
      },
      async releaseSendSlot(...args) {
        calls.releases.push(args);
      },
    },
  };

  const authModule = new Module(authServicePath, module);
  authModule.filename = authServicePath;
  authModule.paths = Module._nodeModulePaths(path.dirname(authServicePath));
  authModule.require = (request) => {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return Module.createRequire(authServicePath)(request);
  };
  authModule._compile(fs.readFileSync(authServicePath, "utf8"), authServicePath);

  return { service: authModule.exports, calls };
}

async function withReviewFlag(value, callback) {
  const previous = process.env.RAZORPAY_REVIEW_LOGIN_ENABLED;
  if (value === undefined) delete process.env.RAZORPAY_REVIEW_LOGIN_ENABLED;
  else process.env.RAZORPAY_REVIEW_LOGIN_ENABLED = value;
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.RAZORPAY_REVIEW_LOGIN_ENABLED;
    else process.env.RAZORPAY_REVIEW_LOGIN_ENABLED = previous;
  }
}

test("provider server-side OTP endpoints default to the Findoly OTP namespace", () => {
  assert.equal(otpClient.OTP_SERVICE_BASE_URL, "https://api.findoly.com/otp");
  assert.equal(otpClient.SEND_OTP_URL, "https://api.findoly.com/otp/send-otp");
  assert.equal(otpClient.VERIFY_OTP_URL, "https://api.findoly.com/otp/verify-otp");
});

test("provider login browser calls only same-origin auth routes", () => {
  const source = read("views/auth/login.ejs");
  assert.match(source, /apiFetch\('\/api\/auth\/send-otp'/);
  assert.match(source, /apiFetch\('\/api\/auth\/verify-otp'/);
  assert.doesNotMatch(source, /api\.findoly\.com/);
  assert.doesNotMatch(source, /localhost:\d+/);
});

test("provider authentication has no exposed development or review OTP", () => {
  const authSource = read("services/auth/auth-service.js");
  const publicSource = [
    read("controllers/authController.js"),
    read("views/auth/login.ejs"),
  ].join("\n");

  assert.doesNotMatch(`${authSource}\n${publicSource}`, /devOtp|DEV_OTP_CODE|Development OTP|123456/);
  assert.doesNotMatch(publicSource, /8693097982|7777|RAZORPAY_REVIEW_LOGIN_ENABLED/);
  assert.match(authSource, /requestOtpApi\(SEND_OTP_URL/);
  assert.match(authSource, /requestOtpApi\(VERIFY_OTP_URL/);
  assert.match(authSource, /RAZORPAY_REVIEW_LOGIN_ENABLED/);
});

test("Razorpay review login is disabled by default and still uses live OTP verification", async () => {
  await withReviewFlag(undefined, async () => {
    const gatewayError = Object.assign(new Error("invalid"), { status: 401 });
    const { service, calls } = loadAuthService({ otpHandler: async () => { throw gatewayError; } });

    await assert.rejects(
      service.verifyOtp("8693097982", "7777"),
      (error) => error?.code === "OTP_INVALID" && error?.status === 401,
    );
    assert.equal(calls.otp.length, 1);
    assert.match(calls.otp[0].url, /verify-otp$/);
  });
});

test("enabled Razorpay review login bypasses OTP delivery only for the approved mobile", async () => {
  await withReviewFlag("true", async () => {
    const { service, calls } = loadAuthService({
      otpHandler: async () => { throw new Error("OTP gateway must not be called"); },
    });

    const result = await service.sendOtp("8693097982");
    assert.equal(result.mobile, "8693097982");
    assert.equal(result.deliveryStatus, "sent");
    assert.equal(result.deliveryUncertain, false);
    assert.equal(calls.claims.length, 1);
    assert.equal(calls.otp.length, 0);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "otp"), false);
    assert.equal(JSON.stringify(result).includes("7777"), false);
  });
});

test("enabled Razorpay review login accepts only OTP 7777 for the approved mobile", async () => {
  await withReviewFlag("true", async () => {
    const { service, calls } = loadAuthService({
      otpHandler: async () => { throw new Error("OTP gateway must not be called"); },
    });

    const provider = await service.verifyOtp("8693097982", "7777");
    assert.equal(provider.providerId, "provider-review");
    assert.equal(calls.otp.length, 0);
    assert.equal(calls.updates.length, 1);

    await assert.rejects(
      service.verifyOtp("8693097982", "7778"),
      (error) => error?.code === "OTP_INVALID" && error?.status === 401,
    );
    assert.equal(calls.otp.length, 0);
  });
});

test("OTP 7777 never bypasses verification for another mobile", async () => {
  await withReviewFlag("true", async () => {
    const gatewayError = Object.assign(new Error("invalid"), { status: 401 });
    const { service, calls } = loadAuthService({ otpHandler: async () => { throw gatewayError; } });

    await assert.rejects(
      service.verifyOtp("9876543210", "7777"),
      (error) => error?.code === "OTP_INVALID" && error?.status === 401,
    );
    assert.equal(calls.otp.length, 1);
    assert.deepEqual(calls.otp[0].payload, { mobile: "9876543210", otp: "7777" });
  });
});

test("Razorpay review login preserves provider eligibility restrictions", async () => {
  await withReviewFlag("true", async () => {
    const { service, calls } = loadAuthService({
      provider: {
        providerId: "provider-review",
        mobile: "8693097982",
        status: "inactive",
        portalAccessEnabled: true,
      },
    });

    await assert.rejects(
      service.sendOtp("8693097982"),
      (error) => error?.code === "PROVIDER_INACTIVE" && error?.status === 403,
    );
    await assert.rejects(
      service.verifyOtp("8693097982", "7777"),
      (error) => error?.code === "PROVIDER_INACTIVE" && error?.status === 403,
    );
    assert.equal(calls.claims.length, 0);
    assert.equal(calls.otp.length, 0);
    assert.equal(calls.updates.length, 0);
  });
});

test("provider OTP configuration requires HTTPS overrides in production", () => {
  const source = read("config/env.js");
  assert.match(source, /Provider OTP service URLs must use HTTPS in production/);
  assert.doesNotMatch(source, /requireProduction\("OTP_API_URL"\)/);
});
