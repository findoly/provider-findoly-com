const walletService = require("../services/wallet/wallet-service");

async function get(req, res, next) {
  try {
    return res.json({
      success: true,
      data: await walletService.get(req.provider, req.query),
    });
  } catch (error) {
    return next(error);
  }
}

async function packages(req, res, next) {
  try {
    return res.json({
      success: true,
      data: await walletService.packages(req.provider),
    });
  } catch (error) {
    return next(error);
  }
}

async function createCreditOrder(req, res, next) {
  try {
    return res.status(201).json({
      success: true,
      data: await walletService.createCreditOrder(req.provider, req.body),
    });
  } catch (error) {
    return next(error);
  }
}

async function cancelCreditOrder(req, res, next) {
  try {
    return res.json({
      success: true,
      data: await walletService.cancelCreditOrder(req.provider, req.body),
    });
  } catch (error) {
    return next(error);
  }
}

async function verifyCredits(req, res, next) {
  try {
    return res.json({
      success: true,
      data: await walletService.verify(req.provider, req.body, {
        purpose: "credit_purchase",
      }),
    });
  } catch (error) {
    return next(error);
  }
}

// New subscription orders are disabled. Legacy cancellation and verification
// remain available so a plan checkout opened before the credit-model rollout
// can still be closed or completed safely.
async function createPlanOrder(req, res, next) {
  return next(Object.assign(
    new Error("Subscription purchases are no longer available. Choose a credit package instead."),
    { status: 409, code: "PLAN_PURCHASE_DISABLED" },
  ));
}

async function cancelPlanOrder(req, res, next) {
  try {
    return res.json({
      success: true,
      data: await walletService.cancelPlanOrder(req.provider, req.body),
    });
  } catch (error) {
    return next(error);
  }
}

async function verify(req, res, next) {
  try {
    return res.json({
      success: true,
      data: await walletService.verify(req.provider, req.body, {
        purpose: "plan_purchase",
      }),
    });
  } catch (error) {
    return next(error);
  }
}

async function webhook(req, res, next) {
  try {
    return res.json({
      success: true,
      data: await walletService.webhook(
        req.body,
        req.headers["x-razorpay-signature"],
      ),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  get,
  packages,
  createCreditOrder,
  cancelCreditOrder,
  verifyCredits,
  createPlanOrder,
  cancelPlanOrder,
  verify,
  webhook,
};
