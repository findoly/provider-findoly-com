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

async function sendProviderFeedback(payload = {}) {
  if (!configured()) {
    return { synced: false, skipped: true, reason: "CRM integration is not configured" };
  }

  const { response, body } = await fetchJson(integrationUrl("provider_feedback_updated"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-communication-token": String(process.env.COMMUNICATION_EVENT_API_TOKEN || ""),
    },
    body: JSON.stringify(payload),
    timeoutMs: Number(process.env.CRM_API_TIMEOUT_MS || 10000),
  });

  if (!response.ok || body?.success === false) {
    const error = new Error(body?.message || "CRM could not synchronize the provider update");
    error.status = 502;
    error.code = "CRM_SYNC_FAILED";
    throw error;
  }

  return { synced: true, data: body?.data || null };
}

module.exports = { configured, sendProviderFeedback };
