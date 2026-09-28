"use strict";

const authService = require("../services/auth.service");
const logger = require("../utils/logger");

function extractBearerToken(req) {
  const header = req.get("authorization") || "";
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match ? match[1] : null;
}

function reject(res, status, error, message) {
  res.set("Cache-Control", "no-store");
  if (status === 401) res.set("WWW-Authenticate", 'Bearer realm="api"');
  const code = error.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
  res.status(status).json({ error, code, message });
}

// 401 when there is no usable, verified identity.
async function requireAuth(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) return reject(res, 401, "Unauthorized", "Authentication required");

  try {
    // Looked up on the module object at call time so tests can stub it.
    req.user = await authService.verifyToken(token);
    return next();
  } catch (err) {
    if (err.status === 503) logger.error("Token verification unavailable", err.cause || err);
    return reject(
      res,
      err.status || 503,
      err.status === 401 ? "Unauthorized" : "ServiceUnavailable",
      err.status === 401 ? err.message : "Authentication service unavailable"
    );
  }
}

// 403 when the verified identity is not an admin. Must run after requireAuth.
function requireAdmin(req, res, next) {
  if (!req.user) return reject(res, 401, "Unauthorized", "Authentication required");
  if (!authService.isAdmin(req.user)) return reject(res, 403, "Forbidden", "Admin access required");
  return next();
}

module.exports = { requireAuth, requireAdmin };
