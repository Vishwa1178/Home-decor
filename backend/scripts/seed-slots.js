#!/usr/bin/env node
"use strict";

// Loads the initial booking slots (backend/data/slots.seed.json) into Firestore
// (`slots/{id}`).
//
//   node scripts/seed-slots.js              # create slots that do not exist yet
//   node scripts/seed-slots.js --overwrite  # reset every seeded slot to the seed values
//   node scripts/seed-slots.js --dry-run    # validate and show what would happen
//
// Safe by default: existing slots are left alone, so capacity/enabled/weekday edits
// made later by an admin are never clobbered by a re-run.
//
// Needs FIREBASE_PROJECT_ID plus credentials (FIREBASE_SERVICE_ACCOUNT_JSON or
// GOOGLE_APPLICATION_CREDENTIALS), or FIRESTORE_EMULATOR_HOST for local testing.

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { getDb } = require("../src/config/firebaseAdmin");
const { slotSeedSchema } = require("../src/schemas/slot.schema");
const { seedDocuments } = require("./lib/seed");

const args = new Set(process.argv.slice(2));
const overwrite = args.has("--overwrite");
const dryRun = args.has("--dry-run");

async function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "slots.seed.json"), "utf8"));
  const parsed = slotSeedSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("slots.seed.json is invalid:");
    for (const i of parsed.error.issues) console.error(`  ${i.path.join(".")}: ${i.message}`);
    process.exit(1);
  }
  const { slots } = parsed.data;

  const ids = new Set();
  const times = new Set();
  for (const s of slots) {
    if (ids.has(s.id)) throw new Error(`duplicate slot id "${s.id}"`);
    if (times.has(s.time)) throw new Error(`two slots start at ${s.time}`);
    ids.add(s.id);
    times.add(s.time);
  }

  const db = getDb();
  const entries = slots.map(({ id, ...data }) => ({ ref: db.collection("slots").doc(id), data, label: `slot ${id} (${data.label})` }));
  const { created, overwritten, skipped } = await seedDocuments({ db, entries, overwrite, dryRun });

  console.log(`${dryRun ? "[dry run] " : ""}slots: ${slots.length} | created: ${created}, overwritten: ${overwritten}, left unchanged: ${skipped}`);
}

main().catch((err) => {
  console.error("Failed:", err.code || err.name, err.message);
  process.exit(1);
});
