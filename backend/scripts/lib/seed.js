"use strict";

// Shared by the seed scripts: create missing documents, or overwrite on request.
// Safe by default: existing documents are left alone, so values an admin edited
// later are never clobbered by a re-run.

const { FieldValue } = require("firebase-admin/firestore");

// entries: [{ ref, data, label }]
async function seedDocuments({ db, entries, overwrite = false, dryRun = false, log = console.log }) {
  const existing = new Set((await db.getAll(...entries.map((e) => e.ref))).filter((s) => s.exists).map((s) => s.ref.path));

  let created = 0;
  let overwritten = 0;
  let skipped = 0;
  const batch = db.batch();
  for (const { ref, data, label } of entries) {
    const exists = existing.has(ref.path);
    if (exists && !overwrite) {
      skipped++;
      continue;
    }
    if (exists) overwritten++;
    else created++;
    if (dryRun) log(`${exists ? "would overwrite" : "would create"} ${label}`);
    batch.set(ref, { ...data, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  }

  if (!dryRun && created + overwritten > 0) await batch.commit();
  return { created, overwritten, skipped };
}

module.exports = { seedDocuments };
