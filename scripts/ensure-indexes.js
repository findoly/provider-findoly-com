"use strict";

require("dotenv").config();
const mongoose = require("mongoose");
const connectDatabase = require("../db/connection");
const { verifySharedIndexes } = require("../db/shared-contract");
const Provider = require("../models/Provider");
const ProviderJoinRequest = require("../models/ProviderJoinRequest");
const ContactIdentity = require("../models/ContactIdentity");
const Enquiry = require("../models/Enquiry");
const ProviderLeadUnlock = require("../models/ProviderLeadUnlock");
const ProviderCrmSyncEvent = require("../models/ProviderCrmSyncEvent");
const ProviderCommunicationEventOutbox = require("../models/ProviderCommunicationEventOutbox");
const PaymentOrder = require("../models/PaymentOrder");
const WalletTransaction = require("../models/WalletTransaction");
const ProviderSubscription = require("../models/ProviderSubscription");
const ProviderOtpRateLimit = require("../models/ProviderOtpRateLimit");

function indexedModels() {
  return [
    Provider,
    ProviderJoinRequest,
    ContactIdentity,
    Enquiry,
    ProviderLeadUnlock,
    ProviderCrmSyncEvent,
    ProviderCommunicationEventOutbox,
    PaymentOrder,
    WalletTransaction,
    ProviderSubscription,
    ProviderOtpRateLimit,
  ];
}

function stableKey(value = {}) {
  return JSON.stringify(Object.entries(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value ?? null;
}

function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function expectedIndexSignatures(model) {
  return model.schema.indexes().map(([key, options = {}]) => ({
    keySignature: stableKey(key),
    unique: Boolean(options.unique),
    sparse: Boolean(options.sparse),
    expireAfterSeconds: options.expireAfterSeconds,
    partialFilterExpression: options.partialFilterExpression,
    name: options.name || "",
  }));
}

function actualIndexSignatures(indexes = []) {
  return indexes.map((index = {}) => ({
    keySignature: stableKey(index.key || {}),
    unique: Boolean(index.unique),
    sparse: Boolean(index.sparse),
    expireAfterSeconds: index.expireAfterSeconds,
    partialFilterExpression: index.partialFilterExpression,
    name: index.name || "",
  }));
}

async function listIndexes(model) {
  try {
    return await model.collection.indexes();
  } catch (error) {
    if (error?.code === 26 || /namespace.*not found/i.test(String(error?.message || ""))) return [];
    throw error;
  }
}

function sameIndex(left, right) {
  return left.keySignature === right.keySignature
    && left.unique === right.unique
    && left.sparse === right.sparse
    && left.expireAfterSeconds === right.expireAfterSeconds
    && sameJson(left.partialFilterExpression, right.partialFilterExpression);
}

async function ensureOwnedIndexes(model, actualIndexes = []) {
  const actual = actualIndexSignatures(actualIndexes);
  let created = 0;
  for (const [key, options = {}] of model.schema.indexes()) {
    const expected = {
      keySignature: stableKey(key),
      unique: Boolean(options.unique),
      sparse: Boolean(options.sparse),
      expireAfterSeconds: options.expireAfterSeconds,
      partialFilterExpression: options.partialFilterExpression,
    };
    if (actual.some((candidate) => sameIndex(candidate, expected))) continue;
    await model.collection.createIndex(key, options);
    created += 1;
  }
  return created;
}

function verifyOwnedIndexes(model, actualIndexes = []) {
  const expected = expectedIndexSignatures(model);
  const actual = actualIndexSignatures(actualIndexes);
  const missing = expected.filter((definition) => !actual.some((candidate) => sameIndex(candidate, definition)));
  if (missing.length) {
    const details = missing.map((index) => index.name || index.keySignature).join(", ");
    const error = new Error(`Missing Provider-owned indexes for ${model.collection.collectionName}: ${details}`);
    error.code = "INDEX_VERIFICATION_FAILED";
    throw error;
  }
  return { expected: expected.length, actual: actual.length };
}

async function run({ verifyOnly = process.argv.includes("--verify-only") } = {}) {
  const connection = await connectDatabase({ verifySharedIndexes: false });

  // Preserve the existing provisioning behavior for the current Provider models.
  if (!verifyOnly) {
    for (const model of indexedModels()) {
      if (model === ProviderCommunicationEventOutbox) continue;
      await model.createIndexes();
      console.log(`Indexes ensured: ${model.modelName}`);
    }
  }

  // The provider communication outbox is owned by this deployment and must be
  // explicitly verified in both ensure and verify-only modes.
  let outboxIndexes = await listIndexes(ProviderCommunicationEventOutbox);
  if (!verifyOnly) {
    const created = await ensureOwnedIndexes(ProviderCommunicationEventOutbox, outboxIndexes);
    if (created) console.log(`Indexes ensured: ${ProviderCommunicationEventOutbox.modelName} (${created} created)`);
    outboxIndexes = await listIndexes(ProviderCommunicationEventOutbox);
  }
  const outboxResult = verifyOwnedIndexes(ProviderCommunicationEventOutbox, outboxIndexes);
  console.log(
    `Indexes verified: ${ProviderCommunicationEventOutbox.collection.collectionName} (${outboxResult.expected} declared, ${outboxResult.actual} present)`,
  );

  const result = await verifySharedIndexes(connection);
  console.log(`Shared indexes verified: ${result.verified}`);
}

if (require.main === module) {
  run()
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    })
    .finally(async () => mongoose.disconnect().catch(() => {}));
}

module.exports = {
  indexedModels,
  expectedIndexSignatures,
  actualIndexSignatures,
  ensureOwnedIndexes,
  verifyOwnedIndexes,
  run,
};
