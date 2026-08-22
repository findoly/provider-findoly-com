const GST_RATE_PERCENT = 18;
const GST_RATE_BASIS_POINTS = GST_RATE_PERCENT * 100;
const MINIMUM_LEAD_CREDITS = 50;

const CREDIT_PACKAGE_DEFINITIONS = Object.freeze([
  Object.freeze({
    code: "starter",
    name: "Starter",
    tagline: "A simple way to start unlocking customer leads",
    recommended: false,
    bestValue: false,
    finalPricePaise: 99900,
    baseCredits: 1000,
    bonusPercent: 0,
    credits: 1000,
  }),
  Object.freeze({
    code: "growth-plus",
    name: "Growth",
    tagline: "For providers unlocking leads regularly",
    recommended: true,
    bestValue: false,
    finalPricePaise: 299900,
    baseCredits: 3000,
    bonusPercent: 10,
    credits: 3300,
  }),
  Object.freeze({
    code: "scale",
    name: "Scale",
    tagline: "For growing businesses that want more lead access",
    recommended: false,
    bestValue: false,
    finalPricePaise: 499900,
    baseCredits: 5000,
    bonusPercent: 20,
    credits: 6000,
  }),
  Object.freeze({
    code: "pro",
    name: "Pro",
    tagline: "For high-volume providers maximising lead opportunities",
    recommended: false,
    bestValue: true,
    finalPricePaise: 999900,
    baseCredits: 10000,
    bonusPercent: 30,
    credits: 13000,
  }),
]);

// These hidden definitions exist only so already-created credit_purchase
// orders from the previous package set can still fulfill the exact credits
// recorded when checkout began. They are never returned by listCreditPackages.
const LEGACY_CREDIT_PACKAGE_DEFINITIONS = Object.freeze([
  Object.freeze({
    code: "growth",
    name: "Growth",
    tagline: "Legacy credit purchase compatibility",
    recommended: false,
    bestValue: false,
    finalPricePaise: 299900,
    baseCredits: 3000,
    bonusPercent: 0,
    credits: 3000,
  }),
  Object.freeze({
    code: "business",
    name: "Business",
    tagline: "Legacy credit purchase compatibility",
    recommended: false,
    bestValue: false,
    finalPricePaise: 999900,
    baseCredits: 10000,
    bonusPercent: 0,
    credits: 10000,
  }),
]);

// Legacy subscription definitions remain available only so already-created
// plan_purchase orders and historical records can still be fulfilled/read
// safely after the portal moves to one-time credit purchases.
const PLAN_DEFINITIONS = Object.freeze([
  Object.freeze({
    code: "starter",
    name: "Starter",
    tagline: "For individual providers getting started",
    recommended: false,
    features: Object.freeze([
      "Access category-matched leads",
      "Credits carry forward while the plan is active",
      "Direct Pay & Unlock remains available",
    ]),
    cycles: Object.freeze({
      monthly: Object.freeze({
        listedPricePaise: 99900,
        bonusPercent: 0,
        durationDays: 30,
        gstIncluded: false,
      }),
      yearly: Object.freeze({
        listedPricePaise: 1199900,
        bonusPercent: 20,
        durationDays: 365,
        gstIncluded: true,
      }),
    }),
  }),
  Object.freeze({
    code: "growth",
    name: "Growth",
    tagline: "For providers unlocking leads regularly",
    recommended: true,
    features: Object.freeze([
      "Higher credit allowance for regular usage",
      "Best fit for growing service businesses",
      "Priority annual bonus of 30% credits",
    ]),
    cycles: Object.freeze({
      monthly: Object.freeze({
        listedPricePaise: 299900,
        bonusPercent: 0,
        durationDays: 30,
        gstIncluded: false,
      }),
      yearly: Object.freeze({
        listedPricePaise: 3599900,
        bonusPercent: 30,
        durationDays: 365,
        gstIncluded: true,
      }),
    }),
  }),
  Object.freeze({
    code: "scale",
    name: "Scale",
    tagline: "For agencies and high-volume providers",
    recommended: false,
    features: Object.freeze([
      "10% bonus credits even on monthly billing",
      "Lowest effective annual credit cost",
      "Designed for high-volume lead activity",
    ]),
    cycles: Object.freeze({
      monthly: Object.freeze({
        listedPricePaise: 999900,
        bonusPercent: 10,
        durationDays: 30,
        gstIncluded: false,
      }),
      yearly: Object.freeze({
        listedPricePaise: 8999900,
        bonusPercent: 40,
        durationDays: 365,
        gstIncluded: true,
      }),
    }),
  }),
]);

function calculateIncludedGst(totalPaise) {
  return Math.round((Number(totalPaise || 0) * GST_RATE_PERCENT) / (100 + GST_RATE_PERCENT));
}

function calculateAddedGst(subtotalPaise) {
  return Math.round((Number(subtotalPaise || 0) * GST_RATE_BASIS_POINTS) / 10000);
}

function baseCreditsForPrice(listedPricePaise) {
  const rupees = Math.round(Number(listedPricePaise || 0) / 100);
  if (!Number.isSafeInteger(rupees) || rupees < 0) return 0;
  return rupees % 100 === 99 ? rupees + 1 : rupees;
}

function presentCreditPackage(definition) {
  const totalAmountPaise = Number(definition.finalPricePaise || 0);
  const gstAmountPaise = calculateIncludedGst(totalAmountPaise);
  const credits = Number(definition.credits || 0);
  const baseCredits = Number(definition.baseCredits || credits);
  const bonusCredits = Math.max(0, credits - baseCredits);
  return {
    packageCode: definition.code,
    code: definition.code,
    name: definition.name,
    tagline: definition.tagline,
    recommended: definition.recommended === true,
    bestValue: definition.bestValue === true,
    finalPricePaise: totalAmountPaise,
    listedPricePaise: totalAmountPaise,
    subtotalPaise: totalAmountPaise - gstAmountPaise,
    gstAmountPaise,
    totalAmountPaise,
    gstRatePercent: GST_RATE_PERCENT,
    gstIncluded: true,
    baseCredits,
    bonusPercent: Number(definition.bonusPercent || 0),
    bonusCredits,
    credits,
    totalCredits: credits,
    minimumLeadCredits: MINIMUM_LEAD_CREDITS,
    estimatedLeads: Math.floor(credits / MINIMUM_LEAD_CREDITS),
    expiresAt: null,
    expiryLabel: "Never expires",
  };
}

function getCreditPackage(packageCode) {
  const code = String(packageCode || "").trim().toLowerCase();
  const definition = [
    ...CREDIT_PACKAGE_DEFINITIONS,
    ...LEGACY_CREDIT_PACKAGE_DEFINITIONS,
  ].find((item) => item.code === code);
  if (!definition) {
    throw Object.assign(new Error("Select a valid Lead Pack"), {
      status: 400,
      code: "CREDIT_PACKAGE_INVALID",
    });
  }
  return presentCreditPackage(definition);
}

function listCreditPackages() {
  return CREDIT_PACKAGE_DEFINITIONS.map(presentCreditPackage);
}

function presentPlanCycle(plan, cycleName, cycle) {
  const baseCredits = baseCreditsForPrice(cycle.listedPricePaise);
  const bonusCredits = Math.round((baseCredits * cycle.bonusPercent) / 100);
  const totalCredits = baseCredits + bonusCredits;
  const gstAmountPaise = cycle.gstIncluded
    ? calculateIncludedGst(cycle.listedPricePaise)
    : calculateAddedGst(cycle.listedPricePaise);
  const subtotalPaise = cycle.gstIncluded
    ? cycle.listedPricePaise - gstAmountPaise
    : cycle.listedPricePaise;
  const totalAmountPaise = cycle.gstIncluded
    ? cycle.listedPricePaise
    : cycle.listedPricePaise + gstAmountPaise;

  return {
    planCode: plan.code,
    planName: plan.name,
    billingCycle: cycleName,
    listedPricePaise: cycle.listedPricePaise,
    subtotalPaise,
    gstAmountPaise,
    totalAmountPaise,
    gstRatePercent: GST_RATE_PERCENT,
    gstIncluded: cycle.gstIncluded,
    baseCredits,
    bonusPercent: cycle.bonusPercent,
    bonusCredits,
    totalCredits,
    durationDays: cycle.durationDays,
  };
}

function getPlan(planCode, billingCycle) {
  const code = String(planCode || "").trim().toLowerCase();
  const cycleName = String(billingCycle || "").trim().toLowerCase();
  const plan = PLAN_DEFINITIONS.find((item) => item.code === code);
  const cycle = plan?.cycles?.[cycleName];

  if (!plan || !cycle || !["monthly", "yearly"].includes(cycleName)) {
    throw Object.assign(new Error("Select a valid plan and billing period"), {
      status: 400,
      code: "PLAN_INVALID",
    });
  }

  return {
    code: plan.code,
    name: plan.name,
    tagline: plan.tagline,
    recommended: plan.recommended,
    features: [...plan.features],
    ...presentPlanCycle(plan, cycleName, cycle),
  };
}

function listPlans() {
  return PLAN_DEFINITIONS.map((plan) => ({
    code: plan.code,
    name: plan.name,
    tagline: plan.tagline,
    recommended: plan.recommended,
    features: [...plan.features],
    monthly: presentPlanCycle(plan, "monthly", plan.cycles.monthly),
    yearly: presentPlanCycle(plan, "yearly", plan.cycles.yearly),
  }));
}

function directPaymentQuote(baseAmountPaise) {
  const subtotalPaise = Math.max(0, Math.round(Number(baseAmountPaise || 0)));
  const gstAmountPaise = calculateAddedGst(subtotalPaise);
  return {
    subtotalPaise,
    gstAmountPaise,
    totalAmountPaise: subtotalPaise + gstAmountPaise,
    gstRatePercent: GST_RATE_PERCENT,
    gstIncluded: false,
  };
}

module.exports = {
  GST_RATE_PERCENT,
  MINIMUM_LEAD_CREDITS,
  CREDIT_PACKAGE_DEFINITIONS,
  PLAN_DEFINITIONS,
  baseCreditsForPrice,
  calculateAddedGst,
  calculateIncludedGst,
  directPaymentQuote,
  getCreditPackage,
  getPlan,
  listCreditPackages,
  listPlans,
};
