"use strict";

function parseBoolean(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalize(value[key]);
    return result;
  }, {});
}

function sameDocument(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function sameKey(left, right) {
  return JSON.stringify(Object.entries(left || {})) === JSON.stringify(Object.entries(right || {}));
}

function findIndex(indexes, key, options = {}) {
  return indexes.find((index) => {
    if (!sameKey(index.key, key)) return false;
    if (options.unique !== undefined && index.unique !== options.unique) return false;
    if (options.name !== undefined && index.name !== options.name) return false;
    if (Object.prototype.hasOwnProperty.call(options, "partialFilterExpression")) {
      const actual = index.partialFilterExpression ?? null;
      const expected = options.partialFilterExpression ?? null;
      if (!sameDocument(actual, expected)) return false;
    }
    if (Object.prototype.hasOwnProperty.call(options, "collation")) {
      const actual = index.collation ?? null;
      const expected = options.collation ?? null;
      if (!sameDocument(actual, expected)) return false;
    }
    return true;
  });
}

async function collectionIndexes(connection, collectionName) {
  try {
    return await connection.db.collection(collectionName).listIndexes().toArray();
  } catch (error) {
    if (error?.codeName === "NamespaceNotFound" || error?.code === 26) return [];
    throw error;
  }
}

async function verifySharedIndexes(connection) {
  const requirements = [
    {
      collectionName: "providers",
      key: { normalizedMobile: 1 },
      options: {
        name: "provider_mobile_unique",
        unique: true,
        partialFilterExpression: { normalizedMobile: { $exists: true, $gt: "" } },
      },
      label: "unique provider mobile",
    },
    {
      collectionName: "providers",
      key: { normalizedWhatsappNumber: 1 },
      options: {
        name: "provider_whatsapp_unique",
        unique: true,
        partialFilterExpression: { normalizedWhatsappNumber: { $exists: true, $gt: "" } },
      },
      label: "unique provider WhatsApp",
    },
    {
      collectionName: "providers",
      key: { normalizedEmail: 1 },
      options: {
        name: "provider_email_unique",
        unique: true,
        partialFilterExpression: { normalizedEmail: { $exists: true, $gt: "" } },
      },
      label: "unique provider email",
    },
    {
      collectionName: "providerjoinrequests",
      key: { normalizedMobile: 1 },
      options: {
        name: "normalizedMobile_1",
        unique: true,
        partialFilterExpression: { $or: [{ status: "new" }, { status: "contacted" }] },
      },
      label: "unique open provider joining request mobile",
    },
    {
      collectionName: "providerjoinrequests",
      key: { normalizedEmail: 1, status: 1, createdAt: -1 },
      options: { name: "normalizedEmail_1_status_1_createdAt_-1" },
      label: "provider request email lookup",
    },
    {
      collectionName: "contactidentities",
      key: { key: 1 },
      options: { name: "key_1", unique: true, partialFilterExpression: null },
      label: "unique shared contact identity",
    },
  ];
  const cache = new Map();
  const missing = [];
  for (const requirement of requirements) {
    const { collectionName, key, options, label } = requirement;
    if (!cache.has(collectionName)) cache.set(collectionName, await collectionIndexes(connection, collectionName));
    if (!findIndex(cache.get(collectionName), key, options)) missing.push(label);
  }
  if (missing.length) {
    const error = new Error(`Required shared MongoDB indexes are missing or incompatible: ${missing.join(", ")}. Run npm run ensure:indexes after the CRM migrations.`);
    error.code = "SHARED_INDEXES_MISSING";
    error.missingIndexes = missing;
    throw error;
  }
  return { verified: requirements.length };
}

async function assertTransactionsSupported(connection) {
  const hello = await connection.db.admin().command({ hello: 1 });
  const supported = Boolean(hello.setName || hello.msg === "isdbgrid");
  if (!supported) {
    const error = new Error("Provider joining requests require MongoDB Atlas, mongos, or a replica set with transactions enabled");
    error.code = "MONGODB_TRANSACTIONS_REQUIRED";
    throw error;
  }
  return true;
}

async function verifyDatabaseContract(connection, options = {}) {
  const production = process.env.NODE_ENV === "production";
  const requireTransactions = options.requireTransactions ?? parseBoolean(
    process.env.PROVIDER_REQUIRE_TRANSACTIONS,
    production,
  );
  const verifyIndexes = options.verifySharedIndexes ?? parseBoolean(
    process.env.PROVIDER_VERIFY_SHARED_INDEXES_ON_STARTUP,
    production,
  );
  if (requireTransactions) await assertTransactionsSupported(connection);
  if (verifyIndexes) await verifySharedIndexes(connection);
  return { requireTransactions, verifyIndexes };
}

module.exports = {
  assertTransactionsSupported,
  canonicalize,
  collectionIndexes,
  findIndex,
  parseBoolean,
  sameDocument,
  verifyDatabaseContract,
  verifySharedIndexes,
};
