"use strict";

const firebaseAdmin = require("../config/firebaseAdmin");
const { env } = require("../config/env");

// Errors from firebase-admin that mean "this token is not acceptable" (client
// problem -> 401). Anything else (network, credentials, misconfiguration) is a
// server-side failure and must fail closed as 503, never as "authenticated".
const INVALID_TOKEN_CODES = new Set([
  "auth/argument-error",
  "auth/invalid-id-token",
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/user-disabled",
  "auth/user-not-found",
]);

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.expose = true;
  }
}

// Verifies a Firebase ID token with the Admin SDK and returns the decoded
// claims. Signature, expiry, audience/issuer and (optionally) revocation are
// checked by the SDK. Nothing about the caller is taken from the request body,
// headers other than the bearer token, or the frontend.
async function verifyToken(idToken) {
  try {
    return await firebaseAdmin.getAdminAuth().verifyIdToken(idToken, env.FIREBASE_CHECK_REVOKED);
  } catch (err) {
    if (INVALID_TOKEN_CODES.has(err?.code)) {
      throw new AuthError(401, "Invalid or expired authentication token");
    }
    const unavailable = new AuthError(503, "Authentication service unavailable");
    unavailable.cause = err;
    throw unavailable;
  }
}

// Admin status comes exclusively from the custom claim inside the verified token.
function isAdmin(decodedToken) {
  return decodedToken?.admin === true;
}

module.exports = { verifyToken, isAdmin, AuthError };
