"use strict";

const logger = require("../utils/logger");
const { env } = require("../config/env");

// Centralized error handler. Never leaks stack traces in production.
// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
  const status = Number(err.status || err.statusCode) || 500;
  const payload = {
    error: err.name || "InternalServerError",
    message: err.expose || status < 500 ? err.message : "Internal Server Error",
  };

  if (env.NODE_ENV !== "production" && err.stack) {
    payload.stack = err.stack;
  }

  if (status >= 500) {
    logger.error(`${req.method} ${req.originalUrl}`, err);
  }

  res.status(status).json(payload);
};
