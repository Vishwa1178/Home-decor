"use strict";

const { FieldValue } = require("firebase-admin/firestore");
const firebaseAdmin = require("../config/firebaseAdmin");
const { AppError } = require("../utils/errors");
const { encodeCursor, decodeCursor } = require("../utils/cursor");
const { iso } = require("../utils/serialize");
const logger = require("../utils/logger");

// Audit trail: `auditLogs/{autoId}`, append-only.
//
// * Every admin mutation writes its entry INSIDE the same Firestore transaction as the
//   change, so a change cannot exist without its record (and vice versa).
// * The actor comes only from the verified ID token (req.user), never from the request body.
// * `before`/`after` hold only the fields that changed, never whole documents, so the log
//   does not become a second copy of customer data.
// * There is no API to edit or delete entries, and Firestore rules deny every client write
//   and read; entries are read through GET /api/admin/audit.

// Who did it and from where, taken from the request the auth middleware already verified.
function contextFrom(req) {
  return {
    actor: { uid: req.user.uid, email: req.user.email || null },
    meta: { ip: req.ip || null, userAgent: String(req.get("user-agent") || "").slice(0, 200) || null },
  };
}

// The document to write. `at` is the server clock, not the client's.
function auditEntry({ action, entityType, entityId, ctx, reason = null, before = null, after = null }) {
  return {
    at: FieldValue.serverTimestamp(),
    action,
    entityType,
    entityId,
    actor: ctx.actor,
    reason: reason || null,
    before,
    after,
    meta: ctx.meta,
  };
}

// A fresh reference. Create it ONCE before the transaction: a retried transaction then
// writes the same document id, so an entry can never be duplicated.
const newAuditRef = (db) => db.collection("auditLogs").doc();

function toAdminAudit(id, d) {
  return {
    id,
    at: iso(d.at),
    action: d.action,
    entityType: d.entityType,
    entityId: d.entityId,
    actor: d.actor,
    reason: d.reason ?? null,
    before: d.before ?? null,
    after: d.after ?? null,
  };
}

// The fields of `patch` whose value differs from `current`, as { before, after }.
function diffFields(current, patch) {
  const before = {};
  const after = {};
  for (const [k, v] of Object.entries(patch)) {
    if (JSON.stringify(current[k] ?? null) !== JSON.stringify(v ?? null)) {
      before[k] = current[k] ?? null;
      after[k] = v ?? null;
    }
  }
  return { before, after, changed: Object.keys(after).length > 0 };
}

async function listAudit({ entityType, entityId, limit, cursor }) {
  const query = { entityType: entityType ?? null, entityId: entityId ?? null };
  try {
    const db = firebaseAdmin.getDb();
    let q = db.collection("auditLogs");
    if (entityType) q = q.where("entityType", "==", entityType);
    if (entityId) q = q.where("entityId", "==", entityId);
    q = q.orderBy("at", "desc");
    if (cursor) {
      const id = decodeCursor(cursor, query);
      const snap = await db.collection("auditLogs").doc(id).get();
      if (!snap.exists) throw new AppError(400, "INVALID_CURSOR", "The pagination cursor is invalid. Start again from the first page.");
      q = q.startAfter(snap);
    }
    const docs = (await q.limit(limit + 1).get()).docs;
    const page = docs.slice(0, limit);
    return {
      entries: page.map((d) => toAdminAudit(d.id, d.data())),
      page: { limit, hasMore: docs.length > limit, nextCursor: docs.length > limit ? encodeCursor(page[page.length - 1].id, query) : null },
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error("Audit lookup failed", err);
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Audit log is temporarily unavailable");
  }
}

module.exports = { contextFrom, auditEntry, newAuditRef, toAdminAudit, diffFields, listAudit };
