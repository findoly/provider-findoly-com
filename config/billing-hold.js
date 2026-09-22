"use strict";

const DEFAULT_BILLING_HOLD_STARTED_AT = "2026-09-22T00:00:00.000Z";

function enabled(env = process.env) {
  const value = String(env.PROVIDER_BILLING_HOLD ?? "true").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(value);
}

function startedAt(env = process.env) {
  const raw = String(
    env.PROVIDER_BILLING_HOLD_STARTED_AT || DEFAULT_BILLING_HOLD_STARTED_AT,
  ).trim();
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return new Date(DEFAULT_BILLING_HOLD_STARTED_AT);
}

function state(env = process.env) {
  const active = enabled(env);
  return {
    active,
    code: active ? "BILLING_HOLD" : "",
    status: active ? "on_hold" : "active",
    startedAt: active ? startedAt(env).toISOString() : null,
    message: active
      ? "Subscription billing and Lead Credit purchases are temporarily on hold. Your existing plan access and available Lead Credits remain usable."
      : "",
  };
}

function purchaseDisabledError(
  message = "Lead Credit purchases are temporarily on hold. Existing credits remain usable.",
) {
  return Object.assign(new Error(message), {
    status: 409,
    code: "BILLING_HOLD",
  });
}

function assertPurchasesOpen(env = process.env) {
  if (enabled(env)) throw purchaseDisabledError();
}

module.exports = {
  DEFAULT_BILLING_HOLD_STARTED_AT,
  enabled,
  startedAt,
  state,
  purchaseDisabledError,
  assertPurchasesOpen,
};
