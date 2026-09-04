"use strict";

const directAccessService = require("../services/lead/provider-direct-access-service");

const COOKIE_NAME = "provider_direct_lead_access";

function cookiePath(leadId) {
  return `/api/lead/${encodeURIComponent(String(leadId || ""))}`;
}

function cookieOptions(leadId, expiresAt) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: cookiePath(leadId),
    expires: expiresAt,
  };
}

function clearOptions(leadId) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: cookiePath(leadId),
  };
}

function tokenFromRequest(req) {
  return String(req.query?.access || "").trim();
}

function apiAccessToken(req) {
  return String(
    req.query?.access
      || req.cookies?.[COOKIE_NAME]
      || "",
  ).trim();
}

function captureForPage(req, res, next) {
  const token = tokenFromRequest(req);
  if (!token) return next();
  const cleanUrl = `/leads/${encodeURIComponent(req.params.leadId)}`;
  try {
    const grant = directAccessService.verify(req.provider, req.params.leadId, token);
    res.cookie(COOKIE_NAME, token, cookieOptions(req.params.leadId, grant.expiresAt));
  } catch (_error) {
    res.clearCookie(COOKIE_NAME, clearOptions(req.params.leadId));
  }
  return res.redirect(302, cleanUrl);
}

module.exports = {
  COOKIE_NAME,
  cookiePath,
  tokenFromRequest,
  apiAccessToken,
  captureForPage,
};
