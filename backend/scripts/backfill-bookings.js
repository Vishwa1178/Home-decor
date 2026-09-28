#!/usr/bin/env node
"use strict";

// One-off, idempotent: adds the fields the admin dashboard's search and sorting rely on to
// bookings created before Phase 5 (`nameLower` for case-insensitive name-prefix search,
// `updatedAt`). Never overwrites a value that exists; touches nothing else.
//
//   node scripts/backfill-bookings.js --dry-run   # count what would change
//   node scripts/backfill-bookings.js             # apply
//
// Needs FIREBASE_PROJECT_ID plus credentials, or FIRESTORE_EMULATOR_HOST for local testing.

require("dotenv").config();

const { getDb } = require("../src/config/firebaseAdmin");

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const db = getDb();
  let scanned = 0;
  let updated = 0;
  let last = null;
  for (;;) {
    let q = db.collection("bookings").orderBy("__name__").limit(400);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;

    const batch = db.batch();
    for (const doc of snap.docs) {
      scanned++;
      const d = doc.data();
      const patch = {};
      if (typeof d.name === "string" && d.nameLower === undefined) patch.nameLower = d.name.toLowerCase();
      if (d.updatedAt === undefined && d.createdAt !== undefined) patch.updatedAt = d.createdAt;
      if (Object.keys(patch).length) {
        updated++;
        if (!dryRun) batch.update(doc.ref, patch);
      }
    }
    if (!dryRun && updated) await batch.commit();
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 400) break;
  }
  console.log(`${dryRun ? "[dry run] " : ""}bookings scanned: ${scanned}, ${dryRun ? "would update" : "updated"}: ${updated}`);
}

main().catch((err) => {
  console.error("Failed:", err.code || err.name, err.message);
  process.exit(1);
});
