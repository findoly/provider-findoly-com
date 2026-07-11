const jwt = require('jsonwebtoken');
const Provider = require('../models/Provider');

function isEligible(provider) {
  return Boolean(provider && String(provider.status).toLowerCase() === 'active' && provider.portalAccessEnabled !== false);
}

async function attachProvider(req, res, next) {
  req.provider = null;
  const token = req.cookies?.[process.env.AUTH_COOKIE_NAME || 'provider_auth'];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'change-provider-secret');
    const provider = await Provider.findOne({ $or: [{ providerId: payload.sub }, { id: payload.sub }, { _id: payload.sub }] }).lean();
    if (isEligible(provider)) {
      req.provider = {
        ...provider,
        providerId: provider.providerId || provider.id || String(provider._id)
      };
    } else {
      res.clearCookie(process.env.AUTH_COOKIE_NAME || 'provider_auth');
    }
  } catch (error) {
    res.clearCookie(process.env.AUTH_COOKIE_NAME || 'provider_auth');
  }
  return next();
}

function pageAuth(req, res, next) {
  if (req.provider) return next();
  return res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl || '/dashboard')}`);
}

function apiAuth(req, res, next) {
  if (req.provider) return next();
  return res.status(401).json({ success: false, message: 'Authentication required' });
}

module.exports = { attachProvider, pageAuth, apiAuth, isEligible };
