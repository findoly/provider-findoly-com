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
    return res.json({
      success: true,
      message: "Service location updated successfully",
      data: await service.updateLocation(req.provider, req.body),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { get, updateLocation };
