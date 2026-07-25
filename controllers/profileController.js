const service = require("../services/profile/profile-service");

async function get(req, res, next) {
  try {
    return res.json({ success: true, data: await service.get(req.provider) });
  } catch (error) {
    return next(error);
  }
}

async function updateLocation(req, res, next) {
  try {
    return res.status(403).json({
      success: false,
      code: "CRM_MANAGED_LOCATION",
      message: "Your service PIN code is managed by Findoly Admin. Contact support to request a change.",
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { get, updateLocation };
