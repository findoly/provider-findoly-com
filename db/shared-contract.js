"use strict";

function parseBoolean(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function sameKey(left, right) {
  return JSON.stringify(Object.entries(left || {})) === JSON.stringify(Object.entries(right || {}));
}

function findIndex(indexes, key, { unique } = {}) {
  return indexes.find((index) => sameKey(index.key, key) && (unique === undefined || index.unique === unique));
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
    ["providers", { normalizedMobile: 1 }, true, "unique provider mobile"],
    ["providers", { normalizedWhatsappNumber: 1 }, true, "unique provider WhatsApp"],
    ["providers", { normalizedEmail: 1 }, true, "unique provider email"],
    ["providerjoinrequests", { normalizedMobile: 1 }, true, "unique open provider joining request mobile"],
    ["providerjoinrequests", { normalizedEmail: 1, status: 1, createdAt: -1 }, undefined, "provider request email lookup"],
    ["contactidentities", { key: 1 }, true, "unique shared contact identity"],
  ];
  const cache = new Map();
  const missing = [];
  for (const [collectionName, key, unique, label] of requirements) {
    if (!cache.has(collectionName)) cache.set(collectionName, await collectionIndexes(connection, collectionName));
    if (!findIndex(cache.get(collectionName), key, { unique })) missing.push(label);
  }
  if (missing.length) {
    const error = new Error(`Required shared MongoDB indexes are missing: ${missing.join(", ")}. Run npm run ensure:indexes after the CRM migrations.`);
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
  collectionIndexes,
  findIndex,
  parseBoolean,
  verifyDatabaseContract,
  verifySharedIndexes,
};
