"use strict";

function parseOrigins(value) {
  if (!value) return true; // reflect request origin
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT) || 5000,
  CORS_ORIGIN: parseOrigins(process.env.CORS_ORIGIN),
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || "",
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || "",
};

module.exports = { env };
