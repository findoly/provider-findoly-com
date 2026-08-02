"use strict";

const mongoose = require("mongoose");
const ContactIdentity = require("../../models/ContactIdentity");
const Provider = require("../../models/Provider");
const ProviderJoinRequest = require("../../models/ProviderJoinRequest");
const { contactEntries } = require("../../utils/contact-normalization");

const ENTITY_CONFIG = Object.freeze({
  provider: { collection: "providers" },
  provider_join_request: { collection: "providerjoinrequests" },
});
const EMPLOYEE_LINKED_TYPES = new Set(["employee", "agent", "provider", "provider_join_request"]);
const PUBLIC_DUPLICATE_MESSAGE = "An account or joining request already exists with these contact details. Please contact support@findoly.com for assistance.";

function duplicateContactError(conflict = {}) {
  const error = new Error(PUBLIC_DUPLICATE_MESSAGE);
  error.status = 409;
  error.code = "CONTACT_ALREADY_EXISTS";
  error.conflict = { kind: conflict.kind || "contact", entityType: conflict.entityType || "record" };
  return error;
}

function sessionOptions(session) { return session ? { session } : {}; }
function ownerFromRow(row = {}) {
  return { entityType: row.entityType || "", entityId: String(row.entityId || ""), field: row.field || "", sourceCollection: row.sourceCollection || "" };
}
function sharedOwners(row = {}) {
  return Array.isArray(row.sharedOwners) ? row.sharedOwners.map((owner) => ({
    entityType: owner.entityType || "", entityId: String(owner.entityId || ""), field: owner.field || "", sourceCollection: owner.sourceCollection || "",
  })) : [];
}
function allOwners(row = {}) { return [ownerFromRow(row), ...sharedOwners(row)].filter((owner) => owner.entityType && owner.entityId); }
function ownerMatches(owner, entityType, entityId) { return owner.entityType === entityType && String(owner.entityId) === String(entityId || ""); }
function hasEmployeeOwner(row = {}) { return allOwners(row).some((owner) => owner.entityType === "employee"); }
function canShareEmployeeLinkedContact(row, entityType, entityId, enabled) {
  if (!enabled || !EMPLOYEE_LINKED_TYPES.has(entityType)) return false;
  const owners = allOwners(row);
  if (!owners.length || owners.some((owner) => !EMPLOYEE_LINKED_TYPES.has(owner.entityType))) return false;
  if (owners.some((owner) => owner.entityType === entityType && !ownerMatches(owner, entityType, entityId))) return false;
  return entityType === "employee" || hasEmployeeOwner(row);
}

async function rawRows(collectionName, query, projection, session) {
  return mongoose.connection.collection(collectionName).find(query, { projection, ...(session ? { session } : {}) }).toArray();
}

function queryForEntry(entry, phoneFields, emailFields) {
  const fields = entry.kind === "phone" ? phoneFields : emailFields;
  return fields.length ? { $or: fields.map((field) => ({ [field]: entry.value })) } : null;
}

async function employeeLinkedKeys(entries, incomingType, session) {
  const linked = new Set(incomingType === "employee" ? entries.map((entry) => entry.key) : []);
  for (const entry of entries) {
    const query = queryForEntry(entry, ["normalizedMobile"], ["normalizedEmail"]);
    if (query) {
      const employee = await mongoose.connection.collection("crmemployees").findOne(query, { projection: { employeeId: 1 }, ...(session ? { session } : {}) });
      if (employee) linked.add(entry.key);
    }
  }
  let lookup = ContactIdentity.find({ key: { $in: entries.map((entry) => entry.key) } });
  if (session) lookup = lookup.session(session);
  for (const row of await lookup.lean()) if (hasEmployeeOwner(row)) linked.add(row.key);
  return linked;
}

async function findRowsForCheck(check, entry, session) {
  const query = queryForEntry(entry, check.phoneFields, check.emailFields);
  if (!query) return [];
  if (check.model) {
    let lookup = check.model.find(query).select({ [check.idField]: 1 });
    if (session) lookup = lookup.session(session);
    return lookup.lean();
  }
  return rawRows(check.collectionName, query, { [check.idField]: 1 }, session);
}

async function findDirectConflict({
  entityType,
  entityId,
  contacts,
  allowEmployeeRoleOverlap = false,
  allowEmployeeProviderOverlap = false,
  session = null,
}) {
  const entries = contactEntries(contacts);
  if (!entries.length) return null;
  const allowOverlap = allowEmployeeRoleOverlap || allowEmployeeProviderOverlap;
  const linkedKeys = allowOverlap ? await employeeLinkedKeys(entries, entityType, session) : new Set();
  const checks = [
    { entityType: "provider", model: Provider, idField: "providerId", phoneFields: ["normalizedMobile", "normalizedWhatsappNumber"], emailFields: ["normalizedEmail"] },
    { entityType: "provider_join_request", model: ProviderJoinRequest, idField: "providerJoinRequestId", phoneFields: ["normalizedMobile", "normalizedWhatsappNumber"], emailFields: ["normalizedEmail"] },
    { entityType: "agent", collectionName: "agents", idField: "agentId", phoneFields: ["normalizedMobile"], emailFields: ["normalizedEmail"] },
    { entityType: "employee", collectionName: "crmemployees", idField: "employeeId", phoneFields: ["normalizedMobile"], emailFields: ["normalizedEmail"] },
  ];

  for (const entry of entries) {
    for (const check of checks) {
      const rows = await findRowsForCheck(check, entry, session);
      for (const row of rows) {
        const existingId = row[check.idField] || "";
        if (check.entityType === entityType && String(existingId) === String(entityId || "")) continue;
        if (check.entityType === entityType) return { kind: entry.kind, entityType: check.entityType, entityId: existingId };
        const employeeLinkedShare = allowOverlap
          && EMPLOYEE_LINKED_TYPES.has(entityType)
          && EMPLOYEE_LINKED_TYPES.has(check.entityType)
          && (entityType === "employee" || linkedKeys.has(entry.key));
        if (!employeeLinkedShare) return { kind: entry.kind, entityType: check.entityType, entityId: existingId };
      }
    }
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
  const enabled = Boolean(options.allowEmployeeRoleOverlap || options.allowEmployeeProviderOverlap);
  const conflict = existing.find((row) => {
    const sameOwner = allOwners(row).some((owner) => ownerMatches(owner, options.entityType, options.entityId));
    return !sameOwner && !canShareEmployeeLinkedContact(row, options.entityType, options.entityId, enabled);
  });
  if (conflict) throw duplicateContactError(conflict);
  return desired;
}

function ownerRecord(entityType, entityId, field, sourceCollection) {
  return { entityType, entityId: String(entityId), field, sourceCollection };
}

async function removeOwnerFromRow(row, entityType, entityId, session) {
  const primaryMatches = ownerMatches(ownerFromRow(row), entityType, entityId);
  const secondaries = sharedOwners(row);
  if (primaryMatches) {
    if (!secondaries.length) return ContactIdentity.deleteOne({ _id: row._id }, sessionOptions(session));
    const [promoted, ...remaining] = secondaries;
    return ContactIdentity.updateOne({ _id: row._id }, { $set: { ...promoted, sharedOwners: remaining, updatedAt: new Date() } }, sessionOptions(session));
  }
  const remaining = secondaries.filter((owner) => !ownerMatches(owner, entityType, entityId));
  if (remaining.length !== secondaries.length) {
    return ContactIdentity.updateOne({ _id: row._id }, { $set: { sharedOwners: remaining, updatedAt: new Date() } }, sessionOptions(session));
  }
  return null;
}

async function syncEntityContacts({
  entityType,
  entityId,
  contacts,
  allowEmployeeRoleOverlap = false,
  allowEmployeeProviderOverlap = false,
  session = null,
}) {
  const config = ENTITY_CONFIG[entityType];
  if (!config || !entityId) throw new Error("Contact identity owner is invalid");
  const desired = await assertContactsAvailable({ entityType, entityId, contacts, allowEmployeeRoleOverlap, allowEmployeeProviderOverlap, session });
  const desiredKeys = desired.map((entry) => entry.key);
  let staleLookup = ContactIdentity.find({
    $or: [{ entityType, entityId }, { sharedOwners: { $elemMatch: { entityType, entityId } } }],
    ...(desiredKeys.length ? { key: { $nin: desiredKeys } } : {}),
  });
  if (session) staleLookup = staleLookup.session(session);
  for (const row of await staleLookup.lean()) await removeOwnerFromRow(row, entityType, entityId, session);

  for (const entry of desired) {
    const incoming = ownerRecord(entityType, entityId, entry.field, config.collection);
    let written = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let lookup = ContactIdentity.findOne({ key: entry.key });
      if (session) lookup = lookup.session(session);
      const row = await lookup.lean();
      if (!row) {
        try {
          await ContactIdentity.create([{
            key: entry.key,
            kind: entry.kind,
            value: entry.value,
            ...incoming,
            sharedOwners: [],
          }], { session });
          written = true;
          break;
        } catch (error) {
          if (error?.code === 11000) continue;
          throw error;
        }
      }
      const owners = allOwners(row);
      const existingIndex = owners.findIndex((owner) => ownerMatches(owner, entityType, entityId));
      if (existingIndex === 0) {
        await ContactIdentity.updateOne(
          { _id: row._id },
          { $set: { kind: entry.kind, value: entry.value, field: entry.field, sourceCollection: config.collection, updatedAt: new Date() } },
          sessionOptions(session),
        );
        written = true;
        break;
      }
      if (existingIndex > 0) {
        const nextShared = sharedOwners(row);
        nextShared[existingIndex - 1] = incoming;
        await ContactIdentity.updateOne(
          { _id: row._id },
          { $set: { kind: entry.kind, value: entry.value, sharedOwners: nextShared, updatedAt: new Date() } },
          sessionOptions(session),
        );
        written = true;
        break;
      }
      if (!canShareEmployeeLinkedContact(
        row,
        entityType,
        entityId,
        allowEmployeeRoleOverlap || allowEmployeeProviderOverlap,
      )) {
        throw duplicateContactError(row);
      }
      await ContactIdentity.updateOne(
        { _id: row._id },
        { $set: { kind: entry.kind, value: entry.value, sharedOwners: [...sharedOwners(row), incoming], updatedAt: new Date() } },
        sessionOptions(session),
      );
      written = true;
      break;
    }
    if (!written) {
      let conflictLookup = ContactIdentity.findOne({ key: entry.key });
      if (session) conflictLookup = conflictLookup.session(session);
      const conflict = await conflictLookup.lean();
      throw duplicateContactError(conflict || entry);
    }
  }
  return desired;
}

module.exports = { PUBLIC_DUPLICATE_MESSAGE, duplicateContactError, findDirectConflict, assertContactsAvailable, syncEntityContacts };
