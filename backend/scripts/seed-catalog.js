#!/usr/bin/env node
"use strict";

// Loads the initial catalog (backend/data/catalog.seed.json) into Firestore
// (`categories/{id}` and `packages/{id}`).
//
//   node scripts/seed-catalog.js              # create documents that do not exist yet
//   node scripts/seed-catalog.js --overwrite  # reset every seeded document to the seed values
//   node scripts/seed-catalog.js --dry-run    # validate and show what would happen
//
// Safe by default: existing documents are left alone, so prices or descriptions
// edited later by an admin are never clobbered by a re-run. --overwrite is the
// deliberate "reset to seed" switch.
//
// Needs FIREBASE_PROJECT_ID plus credentials (FIREBASE_SERVICE_ACCOUNT_JSON or
// GOOGLE_APPLICATION_CREDENTIALS), or FIRESTORE_EMULATOR_HOST for local testing.

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { getDb } = require("../src/config/firebaseAdmin");
const { seedSchema } = require("../src/schemas/catalog.schema");
const { seedDocuments } = require("./lib/seed");

const args = new Set(process.argv.slice(2));
const overwrite = args.has("--overwrite");
const dryRun = args.has("--dry-run");

async function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "catalog.seed.json"), "utf8"));
  const parsed = seedSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("catalog.seed.json is invalid:");
    for (const i of parsed.error.issues) console.error(`  ${i.path.join(".")}: ${i.message}`);
    process.exit(1);
  }
  const { categories, packages } = parsed.data;

  // Referential integrity: every package points at a real category, ids are unique.
  const categoryIds = new Set(categories.map((c) => c.id));
  const packageIds = new Set();
  for (const p of packages) {
    if (!categoryIds.has(p.category)) throw new Error(`package "${p.id}" has unknown category "${p.category}"`);
    if (packageIds.has(p.id)) throw new Error(`duplicate package id "${p.id}"`);
    packageIds.add(p.id);
  }

  const db = getDb();
  const entries = [
    ...categories.map(({ id, ...data }) => ({ ref: db.collection("categories").doc(id), data, label: `category ${id}` })),
    ...packages.map(({ id, ...data }) => ({ ref: db.collection("packages").doc(id), data, label: `package ${id}` })),
  ];

  const { created, overwritten, skipped } = await seedDocuments({ db, entries, overwrite, dryRun });

  console.log(
    `${dryRun ? "[dry run] " : ""}categories: ${categories.length}, packages: ${packages.length} | ` +
      `created: ${created}, overwritten: ${overwritten}, left unchanged: ${skipped}`
  );
}

main().catch((err) => {
  console.error("Failed:", err.code || err.name, err.message);
  process.exit(1);
});
