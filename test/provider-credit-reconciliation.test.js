"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..");

function thenable(result) {
  return {
    session() { return this; },
    sort() { return this; },
    select() { return this; },
    lean() { return this; },
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
}

function compileCreditService({
  provider,
  activeAllocations = [],
  expiringAllocations = [],
  allocationCount = activeAllocations.length + expiringAllocations.length,
} = {}) {
  const filename = path.join(root, "services/billing/credit-service.js");
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));

  const state = {
    provider: { ...provider },
    providerUpdates: [],
    allocationFinds: [],
  };

  const Provider = {
    findOne() {
      return thenable(state.provider);
    },
    findOneAndUpdate(filter, update) {
      state.providerUpdates.push({ filter, update });
      const balance = Number(state.provider.walletBalancePaise || 0);
      const repairingBalance = Object.prototype.hasOwnProperty.call(
        update?.$set || {},
        "walletBalancePaise",
      );
      if (repairingBalance && balance <= 0) {
        state.provider = { ...state.provider, ...update.$set };
        return thenable(state.provider);
      }
      return thenable(null);
    },
  };

  const CreditAllocation = {
    countDocuments() {
      return thenable(allocationCount);
    },
    create() {
      throw new Error("Credit reconciliation must not create allocations");
    },
    updateMany() {
      return thenable({ matchedCount: 0, modifiedCount: 0 });
    },
    updateOne() {
      return thenable({ matchedCount: 1, modifiedCount: 1 });
    },
    find(criteria) {
      state.allocationFinds.push(criteria);
      if (criteria?.expiresAt?.$lte) return thenable(expiringAllocations);
      return thenable(activeAllocations);
    },
  };

  const WalletTransaction = {
    findOne() {
      return thenable(null);
    },
    create() {
      throw new Error("Credit reconciliation must not create wallet transactions");
    },
  };

  loaded.require = (request) => {
    if (request === "../../models/Provider") return Provider;
    if (request === "../../models/CreditAllocation") return CreditAllocation;
    if (request === "../../models/WalletTransaction") return WalletTransaction;
    if (request === "../../utils/uuid") return () => "uuid";
    if (request === "../../utils/provider") {
      return {
        providerQuery(value) {
          return { $or: [{ providerId: value }, { id: value }] };
        },
      };
    }
    if (request === "../../utils/transaction") {
      return { withTransaction: async (callback) => callback({}) };
    }
    if (request === "../../utils/credits") {
      return { creditsFromPaise: (value) => Number(value || 0) / 100 };
    }
    return Module.createRequire(filename)(request);
  };

  loaded._compile(fs.readFileSync(filename, "utf8"), filename);
  return { service: loaded.exports, state };
}

test("zero provider balance is repaired from Admin-compatible active allocations", async () => {
  const { service, state } = compileCreditService({
    provider: {
      _id: "mongo-provider-1",
      providerId: "provider-1",
      walletBalancePaise: 0,
    },
    activeAllocations: [
      {
        source: "crm_manual_credit",
        remainingMinorCredits: 25000,
        expiresAt: null,
      },
      {
        source: "lead_unlock_refund",
        remainingMinorCredits: 10000,
        expiresAt: null,
      },
    ],
  });

  const synced = await service.syncWithinSession("provider-1", { id: "session" });

  assert.equal(synced.walletBalancePaise, 35000);
  assert.equal(state.providerUpdates.length, 1);
  assert.equal(state.providerUpdates[0].update.$set.walletBalancePaise, 35000);
  assert.equal(
    state.allocationFinds.some((criteria) =>
      criteria.status === "active"
      && criteria.remainingMinorCredits?.$gt === 0
      && Array.isArray(criteria.$or)
      && !Object.prototype.hasOwnProperty.call(criteria, "source")),
    true,
  );
});

test("zero balance remains zero when the shared allocation ledger has no spendable credits", async () => {
  const { service, state } = compileCreditService({
    provider: {
      _id: "mongo-provider-2",
      providerId: "provider-2",
      walletBalancePaise: 0,
    },
    activeAllocations: [],
  });

  const synced = await service.syncWithinSession("provider-2", { id: "session" });

  assert.equal(synced.walletBalancePaise, 0);
  assert.equal(state.providerUpdates.length, 0);
});

test("an existing positive provider balance is never overwritten by reconciliation", async () => {
  const { service, state } = compileCreditService({
    provider: {
      _id: "mongo-provider-3",
      providerId: "provider-3",
      walletBalancePaise: 12000,
    },
    activeAllocations: [
      {
        source: "crm_manual_credit",
        remainingMinorCredits: 50000,
        expiresAt: null,
      },
    ],
    allocationCount: 1,
  });

  const synced = await service.syncWithinSession("provider-3", { id: "session" });

  assert.equal(synced.walletBalancePaise, 12000);
  assert.equal(state.providerUpdates.length, 0);
});


test("malformed allocation values cannot corrupt a repaired credit balance", async () => {
  const { service } = compileCreditService({
    provider: {
      _id: "mongo-provider-4",
      providerId: "provider-4",
      walletBalancePaise: 0,
    },
    activeAllocations: [
      { source: "crm_manual_credit", remainingMinorCredits: "invalid", expiresAt: null },
      { source: "lead_unlock_refund", remainingMinorCredits: -1000, expiresAt: null },
      { source: "credit_purchase", remainingMinorCredits: 7500, expiresAt: null },
    ],
  });

  const synced = await service.syncWithinSession("provider-4", { id: "session" });

  assert.equal(synced.walletBalancePaise, 7500);
  assert.equal(Number.isFinite(synced.walletBalancePaise), true);
});
