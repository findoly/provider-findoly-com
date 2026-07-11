const service = require("../services/profile/profile-service");

async function get(req, res, next) {
  try {
    return res.json({
      success: true,
      data: await service.get(req.provider),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { get };
