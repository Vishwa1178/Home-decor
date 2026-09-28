"use strict";

function parseOrigins(value) {
  if (!value) return true; // reflect request origin
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseInt10(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseBool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes"].includes(String(value).trim().toLowerCase());
}

const NODE_ENV = process.env.NODE_ENV || "development";

const env = {
  NODE_ENV,
  PORT: Number(process.env.PORT) || 5000,
  CORS_ORIGIN: parseOrigins(process.env.CORS_ORIGIN),

  // Firebase Admin SDK. The project ID is required to verify ID tokens; the
  // service account is additionally required for revocation checks, setting
  // custom claims and (from Phase 2) writing to Firestore.
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || "",
  FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "",
  // Reject ID tokens that were revoked (e.g. admin claim removed + tokens revoked).
  // Needs service-account credentials, so it defaults to on only in production.
  FIREBASE_CHECK_REVOKED: parseBool(process.env.FIREBASE_CHECK_REVOKED, NODE_ENV === "production"),

  // Booking rules. Amounts are whole Indian rupees; payment amounts (HALF = 50%, FULL = 100%)
  // are calculated in src/utils/pricing.js.
  // Booking dates are validated against "today" in this timezone.
  BUSINESS_TIMEZONE: process.env.BUSINESS_TIMEZONE || "Asia/Kolkata",
  // A slot stops being bookable this many minutes before it starts (0 = once it has started).
  SLOT_CUTOFF_MINUTES: parseInt10(process.env.SLOT_CUTOFF_MINUTES, 0),
  // How long GET /api/packages may be served from memory. Bookings never use the
  // cache: they read the package price inside the Firestore transaction.
  CATALOG_CACHE_TTL_MS: parseInt10(process.env.CATALOG_CACHE_TTL_MS, 30_000),

  // Rate limits, per client IP, in-memory (per instance).
  RATE_LIMIT_BOOKINGS_MAX: parseInt10(process.env.RATE_LIMIT_BOOKINGS_MAX, 10),
  RATE_LIMIT_BOOKINGS_WINDOW_MS: parseInt10(process.env.RATE_LIMIT_BOOKINGS_WINDOW_MS, 15 * 60_000),
  RATE_LIMIT_CATALOG_MAX: parseInt10(process.env.RATE_LIMIT_CATALOG_MAX, 120),
  RATE_LIMIT_CATALOG_WINDOW_MS: parseInt10(process.env.RATE_LIMIT_CATALOG_WINDOW_MS, 60_000),
  RATE_LIMIT_AVAILABILITY_MAX: parseInt10(process.env.RATE_LIMIT_AVAILABILITY_MAX, 120),
  RATE_LIMIT_AVAILABILITY_WINDOW_MS: parseInt10(process.env.RATE_LIMIT_AVAILABILITY_WINDOW_MS, 60_000),
  RATE_LIMIT_ADMIN_MAX: parseInt10(process.env.RATE_LIMIT_ADMIN_MAX, 240),
  RATE_LIMIT_ADMIN_WINDOW_MS: parseInt10(process.env.RATE_LIMIT_ADMIN_WINDOW_MS, 60_000),
};

// Fail fast: without a project ID the API cannot verify tokens, and a silently
// unauthenticated admin surface is worse than a service that refuses to start.
if (NODE_ENV === "production" && !env.FIREBASE_PROJECT_ID) {
  throw new Error("FIREBASE_PROJECT_ID is required when NODE_ENV=production");
}

// The Auth emulator issues UNSIGNED tokens and the Admin SDK trusts them when this
// variable is set. If it leaked into production, anyone could forge an admin token.
if (NODE_ENV === "production" && process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error("FIREBASE_AUTH_EMULATOR_HOST must not be set when NODE_ENV=production");
}

// Same reasoning for Firestore: with this set, bookings would silently go to a local
// emulator instead of the real database.
if (NODE_ENV === "production" && process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("FIRESTORE_EMULATOR_HOST must not be set when NODE_ENV=production");
}

module.exports = { env };
