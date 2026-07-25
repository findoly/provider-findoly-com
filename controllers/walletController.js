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

async function createPlanOrder(req, res, next) {
  try {
    return res.status(201).json({
      success: true,
      data: await walletService.createPlanOrder(req.provider, req.body),
    });
  } catch (error) {
    return next(error);
  }
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

module.exports = { get, createPlanOrder, cancelPlanOrder, verify, webhook };
