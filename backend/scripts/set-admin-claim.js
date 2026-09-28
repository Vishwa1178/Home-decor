#!/usr/bin/env node
"use strict";

// Operator tool: grant or revoke the `admin` custom claim on a Firebase user.
// Run from a trusted machine only. This is the ONLY way to become an admin;
// no HTTP endpoint or frontend value can grant it.
//
//   node scripts/set-admin-claim.js <email|uid>            # grant
//   node scripts/set-admin-claim.js <email|uid> --revoke   # revoke
//
// Needs FIREBASE_PROJECT_ID plus credentials (FIREBASE_SERVICE_ACCOUNT_JSON or
// GOOGLE_APPLICATION_CREDENTIALS), e.g. from backend/.env. Also honours
// FIREBASE_AUTH_EMULATOR_HOST for local testing.
//
// The user must sign in again (or the client must force-refresh its ID token)
// before the change appears in their token.

require("dotenv").config();

const { getAdminAuth } = require("../src/config/firebaseAdmin");

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes("--revoke");
  const target = args.find((a) => !a.startsWith("--"));

  if (!target) {
    console.error("Usage: node scripts/set-admin-claim.js <email|uid> [--revoke]");
    process.exit(2);
  }

  const auth = getAdminAuth();
  // The email is only a lookup convenience for the operator running this script;
  // the authorization decision is the claim we write on the resulting uid.
  const user = target.includes("@") ? await auth.getUserByEmail(target) : await auth.getUser(target);

  const claims = { ...(user.customClaims || {}) };
  if (revoke) delete claims.admin;
  else claims.admin = true;

  await auth.setCustomUserClaims(user.uid, claims);
  if (revoke) await auth.revokeRefreshTokens(user.uid); // kill existing sessions

  console.log(`${revoke ? "Revoked" : "Granted"} admin for uid=${user.uid} (${user.email || "no email"})`);
  console.log("Claims now:", JSON.stringify(claims));
}

main().catch((err) => {
  console.error("Failed:", err.code || err.name, err.message);
  process.exit(1);
});
