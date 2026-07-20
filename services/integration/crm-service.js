const { fetchJson } = require("../../utils/http");

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

  if (!response.ok || body?.success === false) {
    const error = new Error(body?.message || `CRM could not process the ${eventName} communication event`);
    error.status = 502;
    error.code = "CRM_COMMUNICATION_FAILED";
    throw error;
  }

  const data = body?.data || null;
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
  sendEvent,
  sendProviderFeedback,
  sendProviderUnlock,
};
