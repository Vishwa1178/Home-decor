"use strict";

const { FieldValue, FieldPath } = require("firebase-admin/firestore");
const firebaseAdmin = require("../config/firebaseAdmin");
const { env } = require("../config/env");
const clock = require("../utils/clock");
const { AppError, zodIssues } = require("../utils/errors");
const { serializeTimestamps, iso } = require("../utils/serialize");
const { todayInTimezone } = require("../utils/dates");
const { withContentionRetry } = require("../utils/txRetry");
const { slotDocSchema } = require("../schemas/slot.schema");
const { guard } = require("./adminBookings.service");
const slotsService = require("./slots.service");
const audit = require("./audit.service");

// Slot management: add/edit/enable-disable slots, change capacity, block dates, and see
// booked capacity. No deletes (bookings reference slots): disable instead.
// A slot's TIME cannot change: its id (t1000) and the occupancy keys (2030-06-12_t1000) are
// derived from it and existing bookings snapshot it. To move a slot in time, create a new
// one and disable the old one.

const toAdminSlot = (id, d) => ({ id, ...serializeTimestamps(d) });
const missing = (id) => new AppError(404, "SLOT_NOT_FOUND", "Slot not found", [{ field: "id", message: `No slot "${id}"` }]);

function label12h(time) {
  const [h, m] = time.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

async function listSlots() {
  return guard("Listing slots", async () => {
    const snap = await firebaseAdmin.getDb().collection("slots").get();
    return { slots: snap.docs.map((d) => toAdminSlot(d.id, d.data())).sort((a, b) => a.time.localeCompare(b.time) || a.sortOrder - b.sortOrder) };
  });
}

async function createSlot(body, ctx) {
  return guard("Creating a slot", async () => {
    const db = firebaseAdmin.getDb();
    const id = `t${body.time.replace(":", "")}`;
    const doc = { label: label12h(body.time), enabled: true, days: [0, 1, 2, 3, 4, 5, 6], sortOrder: Number(body.time.replace(":", "")), ...body };
    const parsed = slotDocSchema.safeParse(doc);
    if (!parsed.success) throw new AppError(400, "VALIDATION_ERROR", "Request validation failed", zodIssues(parsed.error));

    const ref = db.collection("slots").doc(id);
    const auditRef = audit.newAuditRef(db);
    await withContentionRetry(() =>
      db.runTransaction(async (tx) => {
        if ((await tx.get(ref)).exists) throw new AppError(409, "SLOT_EXISTS", `A slot at ${body.time} already exists (${id}). Edit or re-enable it instead.`, [{ field: "time", message: "Already exists" }]);
        tx.create(ref, { ...parsed.data, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
        tx.create(auditRef, audit.auditEntry({ action: "slot.created", entityType: "slot", entityId: id, ctx, after: parsed.data }));
      })
    );
    return { changed: true, slot: toAdminSlot(id, (await ref.get()).data()) };
  });
}

// Future dates on which a slot already holds more bookings than a lowered capacity allows.
// Existing bookings are never touched; the slot simply takes no new ones until seats free up.
async function overCapacityDates(db, slotId, capacity) {
  const today = todayInTimezone(env.BUSINESS_TIMEZONE, clock.now());
  const snap = await db.collection("slotBookings").where("slotId", "==", slotId).where("date", ">=", today).limit(400).get();
  return snap.docs.filter((d) => (d.data().bookedCount ?? 0) > capacity).map((d) => d.data().date).sort();
}

async function updateSlot(id, patch, ctx) {
  return guard("Updating a slot", async () => {
    const db = firebaseAdmin.getDb();
    const ref = db.collection("slots").doc(id);
    const { expectedUpdatedAt, ...fields } = patch;
    const auditRef = audit.newAuditRef(db);

    const result = await withContentionRetry(() =>
      db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw missing(id);
        const current = snap.data();
        if (expectedUpdatedAt && iso(current.updatedAt) !== expectedUpdatedAt) {
          throw new AppError(409, "STALE_UPDATE", "This slot was changed by someone else. Refresh and try again.");
        }
        const merged = slotDocSchema.safeParse({ ...current, ...fields });
        if (!merged.success) throw new AppError(400, "VALIDATION_ERROR", "Request validation failed", zodIssues(merged.error));

        const diff = audit.diffFields(current, Object.fromEntries(Object.keys(fields).map((k) => [k, merged.data[k]])));
        if (!diff.changed) return { changed: false };
        tx.update(ref, { ...diff.after, updatedAt: FieldValue.serverTimestamp() });
        tx.create(auditRef, audit.auditEntry({ action: "slot.updated", entityType: "slot", entityId: id, ctx, before: diff.before, after: diff.after }));
        return { changed: true, capacity: merged.data.capacity, capacityChanged: "capacity" in diff.after };
      })
    );

    const out = { changed: result.changed, slot: toAdminSlot(id, (await ref.get()).data()), warnings: [] };
    if (result.capacityChanged) {
      const dates = await overCapacityDates(db, id, result.capacity);
      if (dates.length) out.warnings.push({ code: "OVER_CAPACITY", message: `${dates.length} upcoming date(s) already hold more bookings than the new capacity (${dates.slice(0, 5).join(", ")}${dates.length > 5 ? ", …" : ""}). Existing bookings are kept; no new bookings are accepted for those dates until seats free up.`, dates });
    }
    return out;
  });
}

// ── blocked dates ───────────────────────────────────────────────────────────────
const toAdminBlock = (date, d) => ({ date, reason: d.reason ?? "", ...(d.createdAt ? { createdAt: iso(d.createdAt) } : {}), ...(d.updatedAt ? { updatedAt: iso(d.updatedAt) } : {}) });

async function listBlockedDates({ from, to }) {
  return guard("Listing blocked dates", async () => {
    const snap = await firebaseAdmin.getDb().collection("blockedDates").where(FieldPath.documentId(), ">=", from).where(FieldPath.documentId(), "<=", to).get();
    return { blockedDates: snap.docs.map((d) => toAdminBlock(d.id, d.data())).sort((a, b) => a.date.localeCompare(b.date)) };
  });
}

// Bookings already made on a date being blocked are NOT cancelled; the count lets the admin decide.
async function bookingsOnDate(db, date) {
  const snap = await db.collection("slotBookings").where("date", "==", date).get();
  return snap.docs.reduce((n, d) => n + (d.data().bookedCount ?? 0), 0);
}

async function blockDate(date, { reason }, ctx) {
  return guard("Blocking a date", async () => {
    const db = firebaseAdmin.getDb();
    const ref = db.collection("blockedDates").doc(date);
    const auditRef = audit.newAuditRef(db);
    const result = await withContentionRetry(() =>
      db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const text = reason ?? "";
        if (snap.exists && (snap.data().reason ?? "") === text) return { changed: false };
        tx.set(ref, { reason: text, ...(snap.exists ? { createdAt: snap.data().createdAt } : { createdAt: FieldValue.serverTimestamp() }), updatedAt: FieldValue.serverTimestamp() });
        tx.create(auditRef, audit.auditEntry({
          action: snap.exists ? "blockedDate.updated" : "blockedDate.blocked", entityType: "blockedDate", entityId: date, ctx,
          before: snap.exists ? { reason: snap.data().reason ?? "" } : null, after: { reason: text },
        }));
        return { changed: true };
      })
    );
    return { changed: result.changed, blockedDate: toAdminBlock(date, (await ref.get()).data()), existingBookings: await bookingsOnDate(db, date) };
  });
}

async function unblockDate(date, ctx) {
  return guard("Unblocking a date", async () => {
    const db = firebaseAdmin.getDb();
    const ref = db.collection("blockedDates").doc(date);
    const auditRef = audit.newAuditRef(db);
    return withContentionRetry(() =>
      db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return { changed: false };
        tx.delete(ref);
        tx.create(auditRef, audit.auditEntry({ action: "blockedDate.unblocked", entityType: "blockedDate", entityId: date, ctx, before: { reason: snap.data().reason ?? "" } }));
        return { changed: true };
      })
    );
  });
}

// ── booked capacity ─────────────────────────────────────────────────────────────
// Per date and slot: how many seats are taken, for a date range (bounded by the request schema).
async function occupancy({ from, to }) {
  return guard("Reading booked capacity", async () => {
    const db = firebaseAdmin.getDb();
    const [occ, blocked] = await Promise.all([
      db.collection("slotBookings").where("date", ">=", from).where("date", "<=", to).orderBy("date").limit(2000).get(),
      listBlockedDates({ from, to }),
    ]);
    return {
      from, to,
      occupancy: occ.docs.map((d) => ({ date: d.data().date, slotId: d.data().slotId, time: d.data().time, capacity: d.data().capacity, bookedCount: d.data().bookedCount ?? 0 })),
      blockedDates: blocked.blockedDates,
    };
  });
}

module.exports = { listSlots, createSlot, updateSlot, listBlockedDates, blockDate, unblockDate, occupancy, label12h, toAdminSlot };
