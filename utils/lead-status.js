const EMOJI_PATTERN = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u20E3]/u;
const HTML_CODE_PATTERN = /<\/?[A-Za-z][^>]*>|&(?:#\d+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);/u;

function assertPlainHumanText(value, label) {
  const text = String(value || "");
  if (EMOJI_PATTERN.test(text)) {
    throw Object.assign(new Error(`${label} must not contain emoji`), { status: 400, code: "TEXT_EMOJI_NOT_ALLOWED" });
  }
  if (HTML_CODE_PATTERN.test(text)) {
    throw Object.assign(new Error(`${label} must not contain HTML tags or encoded HTML`), { status: 400, code: "TEXT_HTML_NOT_ALLOWED" });
  }
  return text;
}

const ACTIVITY_STATUS_REASONS = Object.freeze({
  contacted: [],
  valid: [],
  follow_up: [],
  on_hold: [],
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
  other: ["other"],
});

const REASON_REQUIRED_STATUSES = Object.freeze([
  "rejected",
  "invalid",
  "not_interested",
  "other",
]);

function normalizeChoice(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function validateSaleOutcome(input = {}) {
  const outcome = normalizeChoice(input.outcome || input.providerSaleOutcome);
  const note = assertPlainHumanText(input.outcomeNote || input.providerSaleOutcomeNote || "", "Outcome note").trim();
  if (!["confirmed", "not_confirmed"].includes(outcome)) {
    throw Object.assign(
      new Error("Select Confirmed or Not Confirmed before saving"),
      { status: 400, code: "PROVIDER_OUTCOME_REQUIRED" },
    );
  }
  if (note.length > 1000) {
    throw Object.assign(new Error("Outcome note must be 1000 characters or less"), {
      status: 400,
      code: "PROVIDER_OUTCOME_NOTE_TOO_LONG",
    });
  }
  return { outcome, outcomeNote: note };
}

function validateActivityStatus(input = {}) {
  const status = normalizeChoice(input.status || input.activityStatus);
  const reason = normalizeChoice(input.reason);
  const note = assertPlainHumanText(input.note || "", "Status note").trim();

  if (!status) return { status: "", reason: "", note };
  if (!Object.prototype.hasOwnProperty.call(ACTIVITY_STATUS_REASONS, status)) {
    throw Object.assign(new Error("Select a valid optional activity status"), {
      status: 400,
      code: "LEAD_STATUS_INVALID",
    });
  }

  if (REASON_REQUIRED_STATUSES.includes(status)) {
    if (!reason || !ACTIVITY_STATUS_REASONS[status].includes(reason)) {
      throw Object.assign(new Error("Select a reason for this activity status"), {
        status: 400,
        code: "LEAD_STATUS_REASON_INVALID",
      });
    }
    if (reason === "other" && !note) {
      throw Object.assign(new Error("Enter a short explanation when Other is selected"), {
        status: 400,
        code: "LEAD_STATUS_NOTE_REQUIRED",
      });
    }
  } else if (reason) {
    throw Object.assign(new Error("A reason is not required for this activity status"), {
      status: 400,
      code: "LEAD_STATUS_REASON_NOT_ALLOWED",
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

function validateLeadFeedback(input = {}) {
  return {
    ...validateSaleOutcome(input),
    ...validateActivityStatus(input),
  };
}

module.exports = {
  ACTIVITY_STATUS_REASONS,
  STATUS_REASONS: ACTIVITY_STATUS_REASONS,
  REASON_REQUIRED_STATUSES,
  validateActivityStatus,
  validateLeadFeedback,
  validateLeadStatus: validateActivityStatus,
  validateSaleOutcome,
};
