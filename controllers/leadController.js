const service = require("../services/lead/lead-service");

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
        req.params.leadDistributionId,
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
        req.params.leadDistributionId,
      ),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { list, get, unlock };
