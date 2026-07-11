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

async function createOrder(req, res, next) {
  try {
    return res.status(201).json({
      success: true,
      data: await walletService.createOrder(
        req.provider,
        req.body.amountPaise,
      ),
    });
  } catch (error) {
    return next(error);
  }
}

async function verify(req, res, next) {
  try {
    return res.json({
      success: true,
      data: await walletService.verify(req.provider, req.body),
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

module.exports = { get, createOrder, verify, webhook };
