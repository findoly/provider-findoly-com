const { fetchJson } = require("../../utils/http");

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function communicationFailure(message) {
  const error = new Error(message);
  error.status = 502;
  error.code = "CRM_COMMUNICATION_FAILED";
  return error;
}

function validateAcknowledgement(body, eventName, payload = {}) {
  if (!plainObject(body) || body.success !== true || !plainObject(body.data)) {
    throw communicationFailure(`CRM returned an invalid acknowledgement for ${eventName}`);
  }
  const acknowledgement = body.data.acknowledgement;
  if (!plainObject(acknowledgement) || acknowledgement.accepted !== true) {
    throw communicationFailure(`CRM did not explicitly acknowledge the ${eventName} communication event`);
  }

  const expectedEventId = String(payload.integrationEventId || "").trim();
  const acknowledgedEventId = String(acknowledgement.integrationEventId || "").trim();
  if (!expectedEventId || acknowledgedEventId !== expectedEventId) {
    throw communicationFailure(`CRM acknowledgement event ID did not match the ${eventName} request`);
  }

  const expectedUnlockId = String(payload.providerLeadUnlockId || "").trim();
  const acknowledgedUnlockId = String(acknowledgement.providerLeadUnlockId || "").trim();
  if (!expectedUnlockId || acknowledgedUnlockId !== expectedUnlockId) {
    throw communicationFailure(`CRM acknowledgement unlock ID did not match the ${eventName} request`);
  }

  const expectedSequence = payload.integrationEventSequence;
  const acknowledgedSequence = acknowledgement.integrationEventSequence;
  if (
    typeof expectedSequence !== "number"
    || !Number.isSafeInteger(expectedSequence)
    || expectedSequence < 1
    || typeof acknowledgedSequence !== "number"
    || !Number.isSafeInteger(acknowledgedSequence)
    || acknowledgedSequence !== expectedSequence
  ) {
    throw communicationFailure(`CRM acknowledgement sequence did not match the ${eventName} request`);
  }

  if (String(acknowledgement.eventName || "") !== eventName) {
    throw communicationFailure(`CRM acknowledgement event name did not match the ${eventName} request`);
  }
  return acknowledgement;
}

function configured() {
  return Boolean(
    String(process.env.CRM_API_BASE_URL || "").trim() &&
    String(process.env.COMMUNICATION_EVENT_API_TOKEN || "").trim(),
  );
}

function integrationUrl(eventName) {
  const base = String(process.env.CRM_API_BASE_URL || "").trim().replace(/\/+$/, "");
  return `${base}${process.env.CRM_COMMUNICATION_EVENT_PATH || "/api/communication/events"}/${encodeURIComponent(eventName)}`;
}

async function sendEvent(eventName, payload = {}) {
  if (!configured()) {
    return { synced: false, skipped: true, reason: "CRM communication integration is not configured" };
  }

  const { response, body } = await fetchJson(integrationUrl(eventName), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-communication-token": String(process.env.COMMUNICATION_EVENT_API_TOKEN || ""),
    },
    body: JSON.stringify(payload),
    timeoutMs: Number(process.env.CRM_API_TIMEOUT_MS || 10000),
  });

  if (!response.ok) {
    throw communicationFailure(body?.message || `CRM could not process the ${eventName} communication event`);
  }

  const acknowledgement = validateAcknowledgement(body, eventName, payload);
  const data = body.data;
  const channelDeliveries = Array.isArray(data?.channelDeliveries)
    ? data.channelDeliveries
    : [];
  const failedDeliveries = channelDeliveries.filter(function (delivery) {
    return delivery && delivery.success === false && delivery.skipped !== true;
  });
  const deliveryWarning = failedDeliveries.length
    ? failedDeliveries
      .map(function (delivery) {
        return `${delivery.channel || "communication"}: ${delivery.error || delivery.reason || "delivery failed"}`;
      })
      .join("; ")
      .slice(0, 1000)
    : "";

  return {
    synced: true,
    acknowledgement,
    data,
    channelDeliveries,
    deliveryFailed: failedDeliveries.length > 0,
    deliveryWarning,
  };
}

async function sendProviderFeedback(payload = {}) {
  return sendEvent("provider_feedback_updated", payload);
}

async function sendProviderUnlock(payload = {}) {
  return sendEvent("provider_lead_unlocked", payload);
}

module.exports = {
  configured,
  validateAcknowledgement,
  sendEvent,
  sendProviderFeedback,
  sendProviderUnlock,
};
