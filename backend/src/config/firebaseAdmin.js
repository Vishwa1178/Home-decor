"use strict";

const { initializeApp, getApps, cert, applicationDefault } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { env } = require("./env");

// Accepts raw JSON or base64-encoded JSON (base64 survives env-var UIs that
// mangle newlines inside the private key).
function parseServiceAccount(value) {
  const text = value.trim().startsWith("{") ? value : Buffer.from(value, "base64").toString("utf8");
  return JSON.parse(text);
}

function buildOptions() {
  const options = {};
  if (env.FIREBASE_PROJECT_ID) options.projectId = env.FIREBASE_PROJECT_ID;

  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    options.credential = cert(parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON));
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    options.credential = applicationDefault();
  }
  // With neither, the SDK still verifies ID tokens (public Google certs only
  // need the project ID). Revocation checks and claim changes will fail closed.
  return options;
}

// Lazily initialised so the API (and /health) can boot without Firebase config.
function getAdminApp() {
  return getApps()[0] || initializeApp(buildOptions());
}

function getAdminAuth() {
  return getAuth(getAdminApp());
}

function getDb() {
  return getFirestore(getAdminApp());
}

module.exports = { getAdminApp, getAdminAuth, getDb };
