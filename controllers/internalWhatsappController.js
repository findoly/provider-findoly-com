"use strict";

const service = require("../services/lead/whatsapp-action-service");

async function viewEnquiry(req, res, next) {
  try {
    const data = await service.processAction(req.body, req.headers);
    return res.json({ success: true, data });
  } catch (error) {
    return next(error);
  }
}

module.exports = { viewEnquiry };
