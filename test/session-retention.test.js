"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = "provider-session-test-secret-with-at-least-32-characters";

const { cookieOptions, clearCookieOptions, createSessionToken, verifySessionToken } = require("../utils/session");
const { validateEnvironment } = require("../config/env");

function withEnv(changes, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(changes)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Provider sessions default to one synchronized 90-day cookie and JWT lifetime", () => {
  withEnv({ AUTH_COOKIE_DAYS: undefined }, () => {
    assert.equal(cookieOptions().maxAge, 90 * 24 * 60 * 60 * 1000);
    assert.equal(Object.hasOwn(clearCookieOptions(), "maxAge"), false);

    const payload = verifySessionToken(createSessionToken("provider-session-test"));
    assert.equal(payload.sub, "provider-session-test");
    assert.equal(payload.type, "provider");
    assert.equal(payload.exp - payload.iat, 90 * 24 * 60 * 60);
  });
});

test("Provider cookie and JWT use the same configured duration", () => {
  withEnv({ AUTH_COOKIE_DAYS: 60 }, () => {
    assert.equal(cookieOptions().maxAge, 60 * 24 * 60 * 60 * 1000);
    const payload = verifySessionToken(createSessionToken("provider-session-custom"));
    assert.equal(payload.exp - payload.iat, 60 * 24 * 60 * 60);
  });
});

test("Provider runtime configuration accepts 1-365 session days only", () => {
  assert.throws(() => withEnv({ NODE_ENV: "development", AUTH_COOKIE_DAYS: 0 }, validateEnvironment), /AUTH_COOKIE_DAYS/);
  assert.throws(() => withEnv({ NODE_ENV: "development", AUTH_COOKIE_DAYS: 366 }, validateEnvironment), /AUTH_COOKIE_DAYS/);
  assert.doesNotThrow(() => withEnv({ NODE_ENV: "development", AUTH_COOKIE_DAYS: 90 }, validateEnvironment));
});
