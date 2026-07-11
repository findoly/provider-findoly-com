const STATUS_REASONS = Object.freeze({
  contacted: [
    "first_contact_completed",
    "follow_up_required",
    "appointment_scheduled",
    "other",
  ],
  confirmed: [
    "customer_confirmed",
    "service_booked",
    "payment_agreed",
    "other",
  ],
  on_hold: [
    "customer_requested_callback",
    "awaiting_customer_response",
    "schedule_pending",
    "price_discussion",
    "other",
  ],
  rejected: [
    "outside_service_area",
    "provider_unavailable",
    "price_not_suitable",
    "duplicate_lead",
    "other",
  ],
  invalid: [
    "invalid_contact",
    "wrong_requirement",
    "fake_or_spam",
    "duplicate_lead",
    "other",
  ],
  not_interested: [
    "customer_not_interested",
    "already_hired_another_provider",
    "budget_issue",
    "no_response",
    "other",
  ],
});

function normalizeChoice(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function validateLeadStatus(input = {}) {
  const status = normalizeChoice(input.status);
  const reason = normalizeChoice(input.reason);
  const note = String(input.note || "").trim();

  if (!Object.prototype.hasOwnProperty.call(STATUS_REASONS, status)) {
    throw Object.assign(new Error("Select a valid lead status"), {
      status: 400,
      code: "LEAD_STATUS_INVALID",
    });
  }

  if (!STATUS_REASONS[status].includes(reason)) {
    throw Object.assign(new Error("Select a valid reason for this status"), {
      status: 400,
      code: "LEAD_STATUS_REASON_INVALID",
    });
  }

  if (reason === "other" && !note) {
    throw Object.assign(new Error("Enter a short reason when Other is selected"), {
      status: 400,
      code: "LEAD_STATUS_NOTE_REQUIRED",
    });
  }

  if (note.length > 1000) {
    throw Object.assign(new Error("Status note must be 1000 characters or less"), {
      status: 400,
      code: "LEAD_STATUS_NOTE_TOO_LONG",
    });
  }

  return { status, reason, note };
}

module.exports = { STATUS_REASONS, validateLeadStatus };
