"use strict";

const { rateLimit } = require("express-rate-limit");
const { env } = require("../config/env");

// Per-client-IP limits, kept in memory (per server instance). The app sets
// `trust proxy` so req.ip is the real client behind Render/Vercel. If the API is
// ever scaled to several instances, move to a shared store (e.g. Redis).
function createLimiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7", // RateLimit + RateLimit-Policy headers, Retry-After on 429
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: "TooManyRequests", code: "RATE_LIMITED", message });
    },
  });
}

const bookingLimiter = createLimiter({
  windowMs: env.RATE_LIMIT_BOOKINGS_WINDOW_MS,
  limit: env.RATE_LIMIT_BOOKINGS_MAX,
  message: "Too many booking requests. Please wait a few minutes and try again.",
});

const catalogLimiter = createLimiter({
  windowMs: env.RATE_LIMIT_CATALOG_WINDOW_MS,
  limit: env.RATE_LIMIT_CATALOG_MAX,
  message: "Too many requests. Please slow down.",
});

const availabilityLimiter = createLimiter({
  windowMs: env.RATE_LIMIT_AVAILABILITY_WINDOW_MS,
  limit: env.RATE_LIMIT_AVAILABILITY_MAX,
  message: "Too many requests. Please slow down.",
});

const adminLimiter = createLimiter({
  windowMs: env.RATE_LIMIT_ADMIN_WINDOW_MS,
  limit: env.RATE_LIMIT_ADMIN_MAX,
  message: "Too many requests. Please slow down.",
});

module.exports = { bookingLimiter, catalogLimiter, availabilityLimiter, adminLimiter };
