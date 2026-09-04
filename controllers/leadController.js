const service = require("../services/lead/lead-service");
const billingService = require("../services/wallet/wallet-service");
const { apiAccessToken } = require("../middleware/direct-lead-access");

function directAccessOptions(req) {
  return { accessToken: apiAccessToken(req) };
}

async function list(req, res, next) {
  try {
    const result = await service.list(req.provider, req.query);
    return res.json({ success: true, ...result });
  } catch (error) {
    return next(error);
  }
}

async function get(req, res, next) {
  try {
    return res.json({
      success: true,
      data: await service.get(
        req.provider,
        req.params.leadId,
        directAccessOptions(req),
      ),
    });
  } catch (error) {
    return next(error);
  }
}

async function unlock(req, res, next) {
  try {
    return res.json({
      success: true,
      data: await service.unlock(
        req.provider,
        req.params.leadId,
        directAccessOptions(req),
      ),
    });
  } catch (error) {
    return next(error);
  }
}

async function createDirectOrder(req, res, next) {
  try {
    return res.status(201).json({
      success: true,
      data: await billingService.createLeadOrder(
        req.provider,
        req.params.leadId,
        directAccessOptions(req),
      ),
    });
  } catch (error) {
    return next(error);
  }
}

async function cancelDirectPayment(req, res, next) {
  try {
    return res.json({
      success: true,
      data: await billingService.cancelLeadOrder(
        req.provider,
        req.params.leadId,
        req.body,
      ),
    });
  } catch (error) {
    return next(error);
  }
}

async function verifyDirectPayment(req, res, next) {
  try {
    return res.json({
      success: true,
      data: await billingService.verifyLead(
        req.provider,
        req.params.leadId,
        req.body,
      ),
    });
  } catch (error) {
    return next(error);
  }
}

async function pendingOutcomes(req, res, next) {
  try {
    const result = await service.pendingOutcomes(req.provider, req.query);
    return res.json({ success: true, ...result });
  } catch (error) {
    return next(error);
  }
}

async function updateStatus(req, res, next) {
  try {
    return res.json({
      success: true,
      data: await service.updateStatus(
        req.provider,
        req.params.leadId,
        req.body,
      ),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  list,
  get,
  unlock,
  createDirectOrder,
  cancelDirectPayment,
  verifyDirectPayment,
  updateStatus,
  pendingOutcomes,
};
