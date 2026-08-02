"use strict";

const Category = require("../../models/Category");
const ProviderJoinRequest = require("../../models/ProviderJoinRequest");
const uuid = require("../../utils/uuid");
const { withTransaction } = require("../../utils/transaction");
const { normalizeEmail, normalizePhone } = require("../../utils/contact-normalization");
const {
  duplicateContactError,
  syncEntityContacts,
} = require("../contact-identity/contact-identity-service");

const OPEN_STATUSES = Object.freeze(["new", "contacted"]);
const UNSUPPORTED_TEXT = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u20E3]|<\/?[A-Za-z][^>]*>|&(?:#\d+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);/u;

function validationError(message, code = "VALIDATION_ERROR", status = 400) {
  return Object.assign(new Error(message), { status, code });
}

function text(value, { label, required = false, maxLength }) {
  const normalized = String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (required && !normalized) throw validationError(`${label} is required`);
  if (normalized.length > maxLength) throw validationError(`${label} must be ${maxLength} characters or less`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized) || UNSUPPORTED_TEXT.test(normalized)) {
    throw validationError(`${label} contains unsupported characters`);
  }
  return normalized;
}

function indianMobile(value, label) {
  const mobile = normalizePhone(value);
  if (!mobile) throw validationError(`${label} must be a valid 10-digit Indian mobile number`);
  return mobile;
}

function email(value) {
  const raw = String(value || "").normalize("NFKC").trim();
  if (!raw) return "";
  const normalized = normalizeEmail(raw);
  if (!normalized || raw.length > 254) throw validationError("Email address is invalid");
  return normalized;
}

function coordinate(value, label, min, max) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw validationError(`${label} is invalid`);
  }
  return number;
}

function booleanValue(value) {
  return value === true || value === "true" || value === "1" || value === 1 || value === "on";
}

async function listActiveCategories() {
  const categories = await Category.find({ active: { $ne: false } })
    .select({ categoryId: 1, id: 1, name: 1, slug: 1 })
    .sort({ name: 1, _id: 1 })
    .limit(500)
    .lean();
  return categories
    .map((category) => ({ ...category, categoryId: category.categoryId || category.id || "" }))
    .filter((category) => category.categoryId && category.slug && category.name);
}

async function submit(input = {}) {
  if (text(input.website, { label: "Website", maxLength: 200 })) {
    return { accepted: true, ignored: true };
  }
  if (!booleanValue(input.consent)) {
    throw validationError("You must agree to the Terms and Conditions and Privacy Policy");
  }

  const mobile = indianMobile(input.mobile, "Mobile number");
  const whatsappNumber = indianMobile(input.whatsappNumber || input.mobile, "WhatsApp number");
  const normalizedEmail = email(input.email);
  const categoryId = text(input.categoryId, { label: "Category", required: true, maxLength: 100 });
  const servicePincode = String(input.servicePincode || "").replace(/\D/g, "").slice(0, 6);
  if (!/^[1-9]\d{5}$/.test(servicePincode)) {
    throw validationError("Service PIN code must contain exactly 6 digits");
  }

  const providerJoinRequestId = uuid();
  let row;
  try {
    row = await withTransaction(async (session) => {
      const category = await Category.findOne({
        active: { $ne: false },
        $or: [{ categoryId }, { id: categoryId }],
      })
        .select({ categoryId: 1, id: 1, name: 1, slug: 1 })
        .session(session)
        .lean();
      if (!category) throw validationError("Select an available service category");

      const contacts = { mobile, whatsappNumber, email: normalizedEmail };
      const [created] = await ProviderJoinRequest.create([
        {
          providerJoinRequestId,
          name: text(input.name, { label: "Full name", required: true, maxLength: 120 }),
          businessName: text(input.businessName, { label: "Business name", maxLength: 160 }),
          mobile,
          normalizedMobile: mobile,
          whatsappNumber,
          normalizedWhatsappNumber: whatsappNumber,
          email: normalizedEmail,
          normalizedEmail,
          categoryId: category.categoryId || category.id,
          categorySlug: category.slug,
          categoryNameSnapshot: category.name,
          serviceAddress: text(input.serviceAddress, { label: "Service address", required: true, maxLength: 500 }),
          servicePincode,
          city: text(input.city, { label: "City", required: true, maxLength: 100 }),
          state: text(input.state, { label: "State", required: true, maxLength: 100 }),
          googlePlaceId: text(input.googlePlaceId, { label: "Google Place ID", maxLength: 255 }),
          latitude: coordinate(input.latitude, "Latitude", -90, 90),
          longitude: coordinate(input.longitude, "Longitude", -180, 180),
          consentAcceptedAt: new Date(),
        },
      ], { session });

      await syncEntityContacts({
        entityType: "provider_join_request",
        entityId: providerJoinRequestId,
        contacts,
        allowEmployeeRoleOverlap: true,
        session,
      });
      return created;
    }, { operationLabel: "Provider joining requests" });
  } catch (error) {
    if (error?.code === 11000) throw duplicateContactError(error);
    throw error;
  }

  console.log(`Provider joining request submitted: ${row.providerJoinRequestId}`);
  return {
    accepted: true,
    providerJoinRequestId: row.providerJoinRequestId,
  };
}

module.exports = { listActiveCategories, submit, OPEN_STATUSES };
