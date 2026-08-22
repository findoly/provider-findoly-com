const Provider = require("../../models/Provider");
const CreditAllocation = require("../../models/CreditAllocation");
const WalletTransaction = require("../../models/WalletTransaction");
const uuid = require("../../utils/uuid");
const { providerQuery } = require("../../utils/provider");
const { withTransaction } = require("../../utils/transaction");
const { creditsFromPaise } = require("../../utils/credits");

function sessionQuery(query, session) {
  return session ? query.session(session) : query;
}

function allocationSort(left, right) {
  const leftExpiry = left.expiresAt ? new Date(left.expiresAt).getTime() : Infinity;
  const rightExpiry = right.expiresAt ? new Date(right.expiresAt).getTime() : Infinity;
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
  return new Date(left.allocatedAt || left.createdAt || 0) - new Date(right.allocatedAt || right.createdAt || 0);
}

async function createLegacyAllocation(provider, session) {
  const providerId = String(provider.providerId || provider.id || "");
  const balance = Number(provider.walletBalancePaise || 0);
  if (!providerId || balance <= 0) return null;

  const existingCount = await sessionQuery(
    CreditAllocation.countDocuments({ providerId }),
    session,
  );
  if (existingCount > 0) return null;

  const creditAllocationId = uuid();
  const [allocation] = await CreditAllocation.create(
    [
      {
        creditAllocationId,
        providerId,
        source: "legacy_credit_balance",
        referenceId: `legacy:${providerId}`,
        amountMinorCredits: balance,
        remainingMinorCredits: balance,
        status: "active",
        allocatedAt: provider.walletUpdatedAt || provider.updatedAt || new Date(),
        expiresAt: null,
        metadata: {
          migratedFrom: "walletBalancePaise",
          note: "Legacy balance preserved as non-expiring credits",
        },
      },
    ],
    { session },
  );

  return allocation.toObject();
}

async function makePurchasedCreditsNonExpiring(providerId, session) {
  const now = new Date();
  return CreditAllocation.updateMany(
    {
      providerId,
      source: "plan_purchase",
      status: "active",
      remainingMinorCredits: { $gt: 0 },
      expiresAt: { $ne: null },
    },
    { $set: { expiresAt: null, updatedAt: now } },
    { session },
  );
}

async function expireAllocations(provider, session, now = new Date()) {
  const providerId = String(provider.providerId || provider.id || "");
  const expiring = await sessionQuery(
    CreditAllocation.find({
      providerId,
      status: "active",
      remainingMinorCredits: { $gt: 0 },
      expiresAt: { $ne: null, $lte: now },
    }).sort({ expiresAt: 1, allocatedAt: 1 }),
    session,
  );

  if (!expiring.length) return provider;

  let runningBalance = Number(provider.walletBalancePaise || 0);
  for (const allocation of expiring) {
    const amount = Math.min(
      runningBalance,
      Math.max(0, Number(allocation.remainingMinorCredits || 0)),
    );

    await CreditAllocation.updateOne(
      { creditAllocationId: allocation.creditAllocationId, status: "active" },
      {
        $set: {
          remainingMinorCredits: 0,
          expiredMinorCredits: Number(allocation.remainingMinorCredits || 0),
          status: "expired",
          expiredAt: now,
          updatedAt: now,
        },
      },
      { session },
    );

    if (amount > 0) {
      const balanceBefore = runningBalance;
      runningBalance = Math.max(0, runningBalance - amount);
      const idempotencyKey = `credit-expiry:${allocation.creditAllocationId}`;
      const existing = await sessionQuery(
        WalletTransaction.findOne({ idempotencyKey }).lean(),
        session,
      );
      if (!existing) {
        await WalletTransaction.create(
          [
            {
              walletTransactionId: uuid(),
              providerId,
              type: "expiry",
              amountPaise: amount,
              currency: "INR",
              balanceBeforePaise: balanceBefore,
              balanceAfterPaise: runningBalance,
              status: "expired",
              source: "plan_expiry",
              referenceId: allocation.creditAllocationId,
              idempotencyKey,
              description: `${creditsFromPaise(amount)} expired at the end of the plan validity period`,
              expiresAt: allocation.expiresAt,
              metadata: {
                planCode: allocation.planCode || "",
                billingCycle: allocation.billingCycle || "",
                providerSubscriptionId: allocation.providerSubscriptionId || "",
              },
            },
          ],
          { session },
        );
      }
    }
  }

  const update = {
    walletBalancePaise: runningBalance,
    walletUpdatedAt: now,
    updatedAt: now,
  };

  if (provider.currentPlanExpiresAt && new Date(provider.currentPlanExpiresAt) <= now) {
    Object.assign(update, {
      currentPlanCode: "",
      currentPlanName: "",
      currentBillingCycle: "",
      currentPlanStartedAt: null,
      currentPlanExpiresAt: null,
      currentSubscriptionId: "",
    });
  }

  const updated = await Provider.findOneAndUpdate(
    providerQuery(providerId),
    { $set: update },
    { new: true, session },
  );
  return updated || provider;
}

async function syncWithinSession(providerId, session) {
  let provider = await sessionQuery(
    Provider.findOne(providerQuery(providerId)),
    session,
  );

  if (!provider) {
    throw Object.assign(new Error("Provider account not found"), {
      status: 404,
      code: "PROVIDER_NOT_FOUND",
    });
  }

  await createLegacyAllocation(provider, session);
  await makePurchasedCreditsNonExpiring(providerId, session);
  provider = await expireAllocations(provider, session);
  return provider;
}

async function syncCredits(providerId, session = null) {
  if (session) return syncWithinSession(providerId, session);
  return withTransaction((transactionSession) =>
    syncWithinSession(providerId, transactionSession),
  );
}

async function activeAllocations(providerId, session) {
  const rows = await sessionQuery(
    CreditAllocation.find({
      providerId,
      status: "active",
      remainingMinorCredits: { $gt: 0 },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    }).lean(),
    session,
  );
  return rows.sort(allocationSort);
}

async function consumeCredits(providerId, amountMinorCredits, session) {
  const amount = Math.max(0, Math.round(Number(amountMinorCredits || 0)));
  const provider = await syncWithinSession(providerId, session);
  const balanceBefore = Number(provider.walletBalancePaise || 0);

  if (balanceBefore < amount) {
    throw Object.assign(new Error("Insufficient credits"), {
      status: 402,
      code: "INSUFFICIENT_BALANCE",
      availableCredits: creditsFromPaise(balanceBefore),
      requiredCredits: creditsFromPaise(amount),
    });
  }

  if (amount === 0) {
    return {
      provider,
      balanceBeforePaise: balanceBefore,
      balanceAfterPaise: balanceBefore,
      consumption: [],
    };
  }

  const allocations = await activeAllocations(providerId, session);
  let remaining = amount;
  const consumption = [];
  const now = new Date();

  for (const allocation of allocations) {
    if (remaining <= 0) break;
    const available = Number(allocation.remainingMinorCredits || 0);
    if (available <= 0) continue;
    const used = Math.min(available, remaining);
    const left = available - used;
    remaining -= used;
    consumption.push({
      creditAllocationId: allocation.creditAllocationId,
      amountMinorCredits: used,
      expiresAt: allocation.expiresAt || null,
    });

    await CreditAllocation.updateOne(
      {
        creditAllocationId: allocation.creditAllocationId,
        status: "active",
        remainingMinorCredits: available,
      },
      {
        $set: {
          remainingMinorCredits: left,
          status: left > 0 ? "active" : "depleted",
          depletedAt: left > 0 ? null : now,
          updatedAt: now,
        },
      },
      { session },
    );
  }

  if (remaining > 0) {
    throw Object.assign(
      new Error("Credit allocations are not consistent with the provider balance"),
      { status: 409, code: "CREDIT_BALANCE_INCONSISTENT" },
    );
  }

  const updatedProvider = await Provider.findOneAndUpdate(
    {
      ...providerQuery(providerId),
      status: "active",
      portalAccessEnabled: { $ne: false },
      walletBalancePaise: { $gte: amount },
    },
    {
      $inc: { walletBalancePaise: -amount },
      $set: { walletUpdatedAt: now, updatedAt: now },
    },
    { new: true, session },
  );

  if (!updatedProvider) {
    throw Object.assign(new Error("Provider credit balance changed. Try again."), {
      status: 409,
      code: "CREDIT_BALANCE_CHANGED",
    });
  }

  return {
    provider: updatedProvider,
    balanceBeforePaise: balanceBefore,
    balanceAfterPaise: Number(updatedProvider.walletBalancePaise || 0),
    consumption,
  };
}

async function addCredits(providerId, allocationInput, session) {
  const provider = await syncWithinSession(providerId, session);
  const amount = Math.max(
    0,
    Math.round(Number(allocationInput.amountMinorCredits || 0)),
  );

  if (!amount) {
    throw Object.assign(new Error("Credit allocation amount is invalid"), {
      status: 400,
      code: "CREDIT_ALLOCATION_INVALID",
    });
  }

  const now = new Date();
  const creditAllocationId = allocationInput.creditAllocationId || uuid();
  const [allocation] = await CreditAllocation.create(
    [
      {
        creditAllocationId,
        providerId,
        source: allocationInput.source,
        referenceId: allocationInput.referenceId || creditAllocationId,
        paymentOrderId: allocationInput.paymentOrderId || "",
        providerSubscriptionId: allocationInput.providerSubscriptionId || "",
        planCode: allocationInput.planCode || "",
        billingCycle: allocationInput.billingCycle || "",
        amountMinorCredits: amount,
        remainingMinorCredits: amount,
        status: "active",
        allocatedAt: allocationInput.allocatedAt || now,
        expiresAt: allocationInput.expiresAt || null,
        metadata: allocationInput.metadata || {},
      },
    ],
    { session },
  );

  const updatedProvider = await Provider.findOneAndUpdate(
    {
      ...providerQuery(providerId),
      status: "active",
      portalAccessEnabled: { $ne: false },
    },
    {
      $inc: { walletBalancePaise: amount },
      $set: { walletUpdatedAt: now, updatedAt: now },
    },
    { new: true, session },
  );

  if (!updatedProvider) {
    throw Object.assign(new Error("Provider account is not eligible"), {
      status: 403,
      code: "PROVIDER_INELIGIBLE",
    });
  }

  return {
    allocation: allocation.toObject(),
    provider: updatedProvider,
    balanceBeforePaise: Number(provider.walletBalancePaise || 0),
    balanceAfterPaise: Number(updatedProvider.walletBalancePaise || 0),
  };
}

async function extendActivePlanAllocations(providerId, expiresAt, session) {
  await CreditAllocation.updateMany(
    {
      providerId,
      source: "plan_purchase",
      status: "active",
      remainingMinorCredits: { $gt: 0 },
      expiresAt: { $ne: null, $gt: new Date() },
    },
    { $set: { expiresAt, updatedAt: new Date() } },
    { session },
  );
}

module.exports = {
  activeAllocations,
  addCredits,
  consumeCredits,
  extendActivePlanAllocations,
  makePurchasedCreditsNonExpiring,
  syncCredits,
  syncWithinSession,
};
