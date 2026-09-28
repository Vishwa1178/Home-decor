"use strict";

const logger = require("../utils/logger");
const { env } = require("../config/env");
const { AppError } = require("../utils/errors");

// Centralized error handler. Every error response has the same shape:
//   { error, code, message, issues? }
// Never leaks stack traces in production.
// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let status = Number(err.status || err.statusCode) || 500;
  let payload;

  if (err instanceof AppError) {
    payload = { error: err.name, code: err.code, message: err.message };
    if (err.issues) payload.issues = err.issues;
    if (err.retryAfter) res.set("Retry-After", String(err.retryAfter));
  } else if (err.type === "entity.parse.failed") {
    status = 400;
    payload = { error: "BadRequest", code: "INVALID_JSON", message: "Request body is not valid JSON" };
  } else if (err.type === "entity.too.large") {
    status = 413;
    payload = { error: "PayloadTooLarge", code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" };
  } else {
    payload = {
      error: err.name || "InternalServerError",
      code: status >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
      message: err.expose || status < 500 ? err.message : "Internal Server Error",
    };
    if (env.NODE_ENV !== "production" && err.stack) payload.stack = err.stack;
  }

  if (status >= 500) logger.error(`${req.method} ${req.originalUrl}`, err);

  res.set("Cache-Control", "no-store").status(status).json(payload);
};
