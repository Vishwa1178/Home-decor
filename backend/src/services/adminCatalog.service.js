"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const firebaseAdmin = require("../config/firebaseAdmin");
const { AppError } = require("../utils/errors");
const { serializeTimestamps, iso } = require("../utils/serialize");
const { withContentionRetry } = require("../utils/txRetry");
const { packageDocSchema, categoryDocSchema } = require("../schemas/catalog.schema");
const { slugify } = require("../schemas/admin.schema");
const { guard } = require("./adminBookings.service");
const catalogService = require("./catalog.service");
const audit = require("./audit.service");
const { zodIssues } = require("../utils/errors");

// Package management for the admin. There is deliberately NO delete: bookings keep
// snapshots of what they bought, and a disabled package is hidden from customers but
// remains editable and re-enableable. Price changes apply to NEW bookings only.

const toAdminPackage = (id, d) => ({ id, ...serializeTimestamps(d) });

const missing = (id) => new AppError(404, "PACKAGE_NOT_FOUND", "Package not found", [{ field: "id", message: `No package "${id}"` }]);

async function requireCategory(readCategory, categoryId) {
  const snap = await readCategory(categoryId);
  if (!snap.exists || !categoryDocSchema.safeParse(snap.data()).success) {
    throw new AppError(422, "CATEGORY_NOT_FOUND", "Unknown category", [{ field: "category", message: `No category "${categoryId}"` }]);
  }
}

// Everything, including disabled packages and categories, for the admin screens.
async function listCatalog() {
  return guard("Listing the catalog", async () => {
    const db = firebaseAdmin.getDb();
    const [pkgs, cats] = await Promise.all([db.collection("packages").get(), db.collection("categories").get()]);
    return {
      packages: pkgs.docs.map((d) => toAdminPackage(d.id, d.data())).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.name).localeCompare(String(b.name))),
      categories: cats.docs.map((d) => ({ id: d.id, ...serializeTimestamps(d.data()) })).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    };
  });
}

async function createPackage(body, ctx) {
  return guard("Creating a package", async () => {
    const db = firebaseAdmin.getDb();
    const id = body.id || slugify(body.name);
    if (!id) throw new AppError(400, "VALIDATION_ERROR", "Request validation failed", [{ field: "name", message: "Could not derive an id from the name" }]);

    const { id: _ignored, ...fields } = body; // eslint-disable-line no-unused-vars
    const doc = { description: "", image: null, active: true, featured: false, sortOrder: 0, ...fields };
    const parsed = packageDocSchema.safeParse(doc);
    if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Request validation failed", zodIssues(parsed.error));

    const ref = db.collection("packages").doc(id);
    const auditRef = audit.newAuditRef(db);
    await withContentionRetry(() =>
      db.runTransaction(async (tx) => {
        const [existing, category] = await tx.getAll(ref, db.collection("categories").doc(parsed.data.category));
        if (existing.exists) throw new AppError(409, "PACKAGE_EXISTS", `A package with id "${id}" already exists`, [{ field: "id", message: "Already exists" }]);
        await requireCategory(async () => category, parsed.data.category);
        tx.create(ref, { ...parsed.data, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
        tx.create(auditRef, audit.auditEntry({ action: "package.created", entityType: "package", entityId: id, ctx, after: parsed.data }));
      })
    );
    catalogService.clearCache(); // customers see it at once (other server instances within CATALOG_CACHE_TTL_MS)
    return { changed: true, package: toAdminPackage(id, (await ref.get()).data()) };
  });
}

async function updatePackage(id, patch, ctx) {
  return guard("Updating a package", async () => {
    const db = firebaseAdmin.getDb();
    const ref = db.collection("packages").doc(id);
    const { expectedUpdatedAt, ...fields } = patch;
    const auditRef = audit.newAuditRef(db);

    const result = await withContentionRetry(() =>
      db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw missing(id);
        const current = snap.data();

        if (expectedUpdatedAt && iso(current.updatedAt) !== expectedUpdatedAt) {
          throw new AppError(409, "STALE_UPDATE", "This package was changed by someone else. Refresh and try again.");
        }
        const merged = packageDocSchema.safeParse({ ...current, ...fields });
        if (!merged.success) throw new AppError(400, "VALIDATION_ERROR", "Request validation failed", zodIssues(merged.error));

        const diff = audit.diffFields(current, Object.fromEntries(Object.keys(fields).map((k) => [k, merged.data[k]])));
        if (!diff.changed) return { changed: false };

        if (fields.category) {
          const category = await tx.get(db.collection("categories").doc(fields.category));
          await requireCategory(async () => category, fields.category);
        }
        tx.update(ref, { ...diff.after, updatedAt: FieldValue.serverTimestamp() });
        tx.create(auditRef, audit.auditEntry({ action: "package.updated", entityType: "package", entityId: id, ctx, before: diff.before, after: diff.after }));
        return { changed: true };
      })
    );
    if (result.changed) catalogService.clearCache();
    return { changed: result.changed, package: toAdminPackage(id, (await ref.get()).data()) };
  });
}

module.exports = { listCatalog, createPackage, updatePackage, toAdminPackage };
