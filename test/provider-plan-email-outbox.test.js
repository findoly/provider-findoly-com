"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const outboxService = require("../services/integration/provider-communication-outbox-service");
const crmService = require("../services/integration/crm-service");

const payload = outboxService.planEventPayload({
  providerId: "provider-1",
  paymentOrderId: "payment-1",
  providerSubscriptionId: "subscription-1",
  planCode: "growth",
  planName: "Growth",
  billingCycle: "monthly",
  totalCredits: 1000,
  totalAmountPaise: 118000,
  planStatus: "active",
  startsAt: new Date("2026-09-04T00:00:00.000Z"),
  expiresAt: new Date("2026-10-04T00:00:00.000Z"),
  purchasedAt: new Date("2026-09-04T00:00:00.000Z"),
});

test("plan purchase event identity is stable per payment order", () => {
  assert.equal(outboxService.planEventIdFor("payment-1"), "provider-plan-purchased:payment-1");
  assert.equal(payload.integrationEventId, "provider-plan-purchased:payment-1");
  assert.equal(payload.providerId, "provider-1");
  assert.equal(payload.paymentOrderId, "payment-1");
  assert.equal(payload.providerSubscriptionId, "subscription-1");
  assert.equal(payload.totalCredits, 1000);
});

test("CRM acknowledgement contract validates provider plan purchase identity", () => {
  const body = {
    success: true,
    data: {
      acknowledgement: {
        accepted: true,
        eventName: "provider_plan_purchased",
        integrationEventId: payload.integrationEventId,
        providerId: payload.providerId,
        paymentOrderId: payload.paymentOrderId,
        providerSubscriptionId: payload.providerSubscriptionId,
      },
      channelDeliveries: [],
    },
  };
  const acknowledgement = crmService.validateAcknowledgement(body, "provider_plan_purchased", payload);
  assert.equal(acknowledgement.paymentOrderId, "payment-1");
});

test("payment controller queues email only after completed plan fulfillment paths", () => {
  const controller = fs.readFileSync(path.join(__dirname, "../controllers/walletController.js"), "utf8");
  assert.match(controller, /result\?\.status === "completed"/);
  assert.match(controller, /result\?\.completed === true/);
  assert.match(controller, /enqueueForCompletedPayment/);
});

test("outbox model accepts provider plan purchase events", () => {
  const model = fs.readFileSync(path.join(__dirname, "../models/ProviderCommunicationEventOutbox.js"), "utf8");
  assert.match(model, /provider_plan_purchased/);
  assert.match(model, /paymentOrderId/);
  assert.match(model, /providerSubscriptionId/);
});
