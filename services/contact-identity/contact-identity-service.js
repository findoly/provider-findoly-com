"use strict";

const mongoose = require("mongoose");
const ContactIdentity = require("../../models/ContactIdentity");
const Provider = require("../../models/Provider");
const ProviderJoinRequest = require("../../models/ProviderJoinRequest");
const { contactEntries, normalizePhone } = require("../../utils/contact-normalization");

const ENTITY_CONFIG = Object.freeze({
  provider: { collection: "providers" },
  provider_join_request: { collection: "providerjoinrequests" },
});

const PUBLIC_DUPLICATE_MESSAGE = "An account or joining request already exists with these contact details. Please contact support@findoly.com for assistance.";

function duplicateContactError(conflict = {}) {
  const error = new Error(PUBLIC_DUPLICATE_MESSAGE);
  error.status = 409;
  error.code = "CONTACT_ALREADY_EXISTS";
  error.conflict = {
    kind: conflict.kind || "contact",
    entityType: conflict.entityType || "record",
  };
  return error;
}

function sessionOptions(session) {
  return session ? { session } : {};
}

function alternativesFor(entries, phoneFields, emailFields) {
  const phones = [...new Set(entries.filter((entry) => entry.kind === "phone").map((entry) => entry.value))];
  const emails = [...new Set(entries.filter((entry) => entry.kind === "email").map((entry) => entry.value))];
  const alternatives = [];
  for (const field of phoneFields) {
    if (phones.length) alternatives.push({ [field]: { $in: phones } });
  }
  for (const field of emailFields) {
    if (emails.length) alternatives.push({ [field]: { $in: emails } });
  }
  return { alternatives, phones };
}

async function modelConflict({ model, entityType, idField, entityId, entries, phoneFields, emailFields, session }) {
  const { alternatives, phones } = alternativesFor(entries, phoneFields, emailFields);
  if (!alternatives.length) return null;
  const query = { $or: alternatives };
  if (entityId) query[idField] = { $ne: entityId };
  let lookup = model.findOne(query).select({
    [idField]: 1,
    normalizedMobile: 1,
    mobile: 1,
    normalizedWhatsappNumber: 1,
    whatsappNumber: 1,
    normalizedEmail: 1,
    email: 1,
  });
  if (session) lookup = lookup.session(session);
  const row = await lookup.lean();
  if (!row) return null;
  const rowPhones = new Set([
    normalizePhone(row.normalizedMobile || row.mobile),
    normalizePhone(row.normalizedWhatsappNumber || row.whatsappNumber),
  ].filter(Boolean));
  return {
    kind: phones.some((phone) => rowPhones.has(phone)) ? "phone" : "email",
    entityType,
    entityId: row[idField] || "",
  };
}

async function collectionConflict({ collectionName, entityType, idField, entityId, entries, session }) {
  const { alternatives, phones } = alternativesFor(
    entries,
    ["normalizedMobile"],
    ["normalizedEmail"],
  );
  if (!alternatives.length) return null;
  const query = { $or: alternatives };
  if (entityId) query[idField] = { $ne: entityId };
  const row = await mongoose.connection.collection(collectionName).findOne(query, {
    projection: {
      [idField]: 1,
      normalizedMobile: 1,
      mobile: 1,
      normalizedEmail: 1,
      email: 1,
    },
    ...(session ? { session } : {}),
  });
  if (!row) return null;
  const rowPhone = normalizePhone(row.normalizedMobile || row.mobile);
  return {
    kind: rowPhone && phones.includes(rowPhone) ? "phone" : "email",
    entityType,
    entityId: row[idField] || "",
  };
}

async function findDirectConflict({ entityType, entityId, contacts, session = null }) {
  const entries = contactEntries(contacts);
  if (!entries.length) return null;

  const checks = [
    () => modelConflict({
      model: Provider,
      entityType: "provider",
      idField: "providerId",
      entityId: entityType === "provider" ? entityId : "",
      entries,
      phoneFields: ["normalizedMobile", "normalizedWhatsappNumber"],
      emailFields: ["normalizedEmail"],
      session,
    }),
    () => modelConflict({
      model: ProviderJoinRequest,
      entityType: "provider_join_request",
      idField: "providerJoinRequestId",
      entityId: entityType === "provider_join_request" ? entityId : "",
      entries,
      phoneFields: ["normalizedMobile", "normalizedWhatsappNumber"],
      emailFields: ["normalizedEmail"],
      session,
    }),
    () => collectionConflict({
      collectionName: "agents",
      entityType: "agent",
      idField: "agentId",
      entityId: entityType === "agent" ? entityId : "",
      entries,
      session,
    }),
    () => collectionConflict({
      collectionName: "crmemployees",
      entityType: "employee",
      idField: "employeeId",
      entityId: entityType === "employee" ? entityId : "",
      entries,
      session,
    }),
  ];

  for (const check of checks) {
    const conflict = await check();
    if (conflict) return conflict;
  }
  return null;
}

async function assertContactsAvailable(options) {
  const direct = await findDirectConflict(options);
  if (direct) throw duplicateContactError(direct);

  const desired = contactEntries(options.contacts);
  if (!desired.length) return desired;
  let lookup = ContactIdentity.find({ key: { $in: desired.map((entry) => entry.key) } });
  if (options.session) lookup = lookup.session(options.session);
  const existing = await lookup.lean();
  const conflict = existing.find((row) => !(
    row.entityType === options.entityType
    && String(row.entityId) === String(options.entityId || "")
  ));
  if (conflict) throw duplicateContactError(conflict);
  return desired;
}

async function syncEntityContacts({ entityType, entityId, contacts, session = null }) {
  const config = ENTITY_CONFIG[entityType];
  if (!config || !entityId) throw new Error("Contact identity owner is invalid");
  const desired = await assertContactsAvailable({ entityType, entityId, contacts, session });
  const desiredKeys = desired.map((entry) => entry.key);

  await ContactIdentity.deleteMany(
    {
      entityType,
      entityId,
      ...(desiredKeys.length ? { key: { $nin: desiredKeys } } : {}),
    },
    sessionOptions(session),
  );

  for (const entry of desired) {
    try {
      await ContactIdentity.updateOne(
        { key: entry.key, entityType, entityId },
        {
          $setOnInsert: { key: entry.key },
          $set: {
            kind: entry.kind,
            value: entry.value,
            entityType,
            entityId,
            field: entry.field,
            sourceCollection: config.collection,
            updatedAt: new Date(),
          },
        },
        { ...sessionOptions(session), upsert: true },
      );
    } catch (error) {
      if (error?.code === 11000) {
        let conflictLookup = ContactIdentity.findOne({ key: entry.key });
        if (session) conflictLookup = conflictLookup.session(session);
        const conflict = await conflictLookup.lean();
        throw duplicateContactError(conflict || entry);
      }
      throw error;
    }
  }
  return desired;
}

module.exports = {
  PUBLIC_DUPLICATE_MESSAGE,
  duplicateContactError,
  findDirectConflict,
  assertContactsAvailable,
  syncEntityContacts,
};
